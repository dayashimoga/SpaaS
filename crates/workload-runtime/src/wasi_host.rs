use wasmi::{Caller, Linker};

/// Host state tracked inside the WebAssembly store during execution
pub struct HostState {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub max_output_bytes: usize,
    pub exit_code: Option<i32>,
    pub args: Vec<String>,
    pub env_vars: Vec<(String, String)>,
    pub fuel_limit: u64,
}

impl HostState {
    pub fn new(
        max_output_bytes: usize,
        fuel_limit: u64,
        args: Vec<String>,
        env_vars: Vec<(String, String)>,
    ) -> Self {
        Self {
            stdout: Vec::new(),
            stderr: Vec::new(),
            max_output_bytes,
            exit_code: None,
            args,
            env_vars,
            fuel_limit,
        }
    }

    pub fn append_stdout(&mut self, data: &[u8]) -> Result<usize, ()> {
        if self.stdout.len() + data.len() > self.max_output_bytes {
            let allowed = self.max_output_bytes.saturating_sub(self.stdout.len());
            self.stdout.extend_from_slice(&data[..allowed]);
            return Err(()); // Quota exceeded
        }
        self.stdout.extend_from_slice(data);
        Ok(data.len())
    }

    pub fn append_stderr(&mut self, data: &[u8]) -> Result<usize, ()> {
        if self.stderr.len() + data.len() > self.max_output_bytes {
            let allowed = self.max_output_bytes.saturating_sub(self.stderr.len());
            self.stderr.extend_from_slice(&data[..allowed]);
            return Err(()); // Quota exceeded
        }
        self.stderr.extend_from_slice(data);
        Ok(data.len())
    }
}

/// Links sandboxed WASI snapshot preview 1 host functions into linker
pub fn link_sandboxed_wasi(linker: &mut Linker<HostState>) -> Result<(), wasmi::Error> {
    // 1. proc_exit: (rval: i32) -> ()
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "proc_exit",
        |mut caller: Caller<'_, HostState>, rval: i32| {
            caller.data_mut().exit_code = Some(rval);
        },
    )?;

    // 2. fd_write: (fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> errno: i32
    // fd 1 = stdout, fd 2 = stderr
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_write",
        |mut caller: Caller<'_, HostState>,
         fd: i32,
         iovs: i32,
         iovs_len: i32,
         nwritten: i32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28, // EFAULT
            };

            let mut total_written: u32 = 0;
            let mut buffer = Vec::new();

            // Read iovecs: each iovec is { ptr: u32, len: u32 } (8 bytes)
            for i in 0..iovs_len {
                let offset = (iovs as usize) + (i as usize * 8);
                let mut iov_buf = [0u8; 8];
                if memory.read(&caller, offset, &mut iov_buf).is_err() {
                    return 28; // EFAULT
                }
                let ptr = u32::from_le_bytes([iov_buf[0], iov_buf[1], iov_buf[2], iov_buf[3]]) as usize;
                let len = u32::from_le_bytes([iov_buf[4], iov_buf[5], iov_buf[6], iov_buf[7]]) as usize;

                let mut data = vec![0u8; len];
                if memory.read(&caller, ptr, &mut data).is_err() {
                    return 28; // EFAULT
                }
                buffer.extend_from_slice(&data);
                total_written += len as u32;
            }

            let result = match fd {
                1 => caller.data_mut().append_stdout(&buffer),
                2 => caller.data_mut().append_stderr(&buffer),
                _ => return 8, // EBADF
            };

            // Write nwritten back to memory
            let nwritten_bytes = total_written.to_le_bytes();
            if memory.write(&mut caller, nwritten as usize, &nwritten_bytes).is_err() {
                return 28; // EFAULT
            }

            if result.is_err() {
                return 27; // EFBIG (File too large / quota exceeded)
            }

            0 // Success (ESUCCESS)
        },
    )?;

    // 3. fd_read: (fd, iovs, iovs_len, nread) -> errno
    // Standard in returns EOF (0 read)
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_read",
        |mut caller: Caller<'_, HostState>,
         _fd: i32,
         _iovs: i32,
         _iovs_len: i32,
         nread: i32|
         -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            let zero = 0u32.to_le_bytes();
            let _ = memory.write(&mut caller, nread as usize, &zero);
            0
        },
    )?;

    // 4. fd_close: (fd) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_close",
        |_caller: Caller<'_, HostState>, _fd: i32| -> i32 { 0 },
    )?;

    // 5. fd_seek: (fd, offset, whence, newoffset) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_seek",
        |_caller: Caller<'_, HostState>, _fd: i32, _offset: i64, _whence: i32, _newoffset: i32| -> i32 {
            70 // ESPIPE
        },
    )?;

    // 6. fd_fdstat_get: (fd, stat_buf) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "fd_fdstat_get",
        |mut caller: Caller<'_, HostState>, fd: i32, stat_buf: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            // 24 bytes fdstat struct:
            // [0..1]: fs_filetype (2 = character device for stdout/err)
            // [2..3]: fs_flags
            // [8..16]: fs_rights_base
            // [16..24]: fs_rights_inheriting
            let mut stat = [0u8; 24];
            if fd == 1 || fd == 2 {
                stat[0] = 2; // character device
            }
            let _ = memory.write(&mut caller, stat_buf as usize, &stat);
            0
        },
    )?;

    // 7. environ_sizes_get: (environ_count, environ_buf_size) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "environ_sizes_get",
        |mut caller: Caller<'_, HostState>, count_ptr: i32, buf_size_ptr: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            let count = caller.data().env_vars.len() as u32;
            let mut size: u32 = 0;
            for (k, v) in &caller.data().env_vars {
                size += (k.len() + 1 + v.len() + 1) as u32; // "K=V\0"
            }

            let _ = memory.write(&mut caller, count_ptr as usize, &count.to_le_bytes());
            let _ = memory.write(&mut caller, buf_size_ptr as usize, &size.to_le_bytes());
            0
        },
    )?;

    // 8. environ_get: (environ, environ_buf) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "environ_get",
        |mut caller: Caller<'_, HostState>, mut env_ptrs: i32, mut buf_ptr: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };

            let env_vars = caller.data().env_vars.clone();
            for (k, v) in env_vars {
                let entry = format!("{k}={v}\0");
                let entry_bytes = entry.as_bytes();

                // write pointer to env_ptrs
                let _ = memory.write(&mut caller, env_ptrs as usize, &(buf_ptr as u32).to_le_bytes());
                env_ptrs += 4;

                // write string to buf_ptr
                let _ = memory.write(&mut caller, buf_ptr as usize, entry_bytes);
                buf_ptr += entry_bytes.len() as i32;
            }
            0
        },
    )?;

    // 9. args_sizes_get: (argc_ptr, argv_buf_size_ptr) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "args_sizes_get",
        |mut caller: Caller<'_, HostState>, argc_ptr: i32, buf_size_ptr: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            let count = caller.data().args.len() as u32;
            let mut size: u32 = 0;
            for arg in &caller.data().args {
                size += (arg.len() + 1) as u32;
            }

            let _ = memory.write(&mut caller, argc_ptr as usize, &count.to_le_bytes());
            let _ = memory.write(&mut caller, buf_size_ptr as usize, &size.to_le_bytes());
            0
        },
    )?;

    // 10. args_get: (argv, argv_buf) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "args_get",
        |mut caller: Caller<'_, HostState>, mut argv_ptrs: i32, mut buf_ptr: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };

            let args = caller.data().args.clone();
            for arg in args {
                let entry = format!("{arg}\0");
                let entry_bytes = entry.as_bytes();

                let _ = memory.write(&mut caller, argv_ptrs as usize, &(buf_ptr as u32).to_le_bytes());
                argv_ptrs += 4;

                let _ = memory.write(&mut caller, buf_ptr as usize, entry_bytes);
                buf_ptr += entry_bytes.len() as i32;
            }
            0
        },
    )?;

    // 11. clock_time_get: (id, precision, time_ptr) -> errno
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "clock_time_get",
        |mut caller: Caller<'_, HostState>, _id: i32, _precision: i64, time_ptr: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            // Deterministic or system time in nanoseconds
            let now_nanos = (chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)) as u64;
            let _ = memory.write(&mut caller, time_ptr as usize, &now_nanos.to_le_bytes());
            0
        },
    )?;

    // 12. random_get: (buf, buf_len) -> errno (Secure random generation)
    linker.func_wrap(
        "wasi_snapshot_preview1",
        "random_get",
        |mut caller: Caller<'_, HostState>, buf: i32, buf_len: i32| -> i32 {
            let memory = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                Some(mem) => mem,
                None => return 28,
            };
            let mut rand_bytes = vec![0u8; buf_len as usize];
            // Fill pseudo/secure random
            for b in rand_bytes.iter_mut() {
                *b = (rand::random::<u8>()) ^ 0x5a;
            }
            let _ = memory.write(&mut caller, buf as usize, &rand_bytes);
            0
        },
    )?;

    Ok(())
}
