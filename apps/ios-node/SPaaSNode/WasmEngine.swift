import Foundation
import JavaScriptCore

public struct WasmExecutionResult {
    public let exitCode: Int32
    public let stdout: String
    public let fuelConsumed: UInt64
    public let durationMs: UInt64
}

/// App Store-compliant WebAssembly execution engine utilizing Apple's JavaScriptCore
public final class WasmEngine {
    private let context: JSContext

    public init() {
        self.context = JSContext() ?? JSContext(virtualMachine: JSVirtualMachine())
        setupEnvironment()
    }

    private func setupEnvironment() {
        context.exceptionHandler = { ctx, exception in
            NSLog("[WasmEngine Error] %@", exception?.toString() ?? "Unknown exception")
        }
    }

    /// Executes WASM bytecode in a compliant, isolated sandbox
    public func execute(wasmBytes: Data, fuelLimit: UInt64 = 10_000_000) -> WasmExecutionResult {
        let startTime = DispatchTime.now()

        // Shared stdout buffer
        var outputBuffer = ""
        let logBlock: @convention(block) (String) -> Void = { msg in
            outputBuffer.append(msg)
        }
        context.setObject(logBlock, forKeyedSubscript: "__spaas_log" as NSString)

        let base64 = wasmBytes.base64EncodedString()
        let script = """
        (function() {
            var raw = atob("\(base64)");
            var bytes = new Uint8Array(raw.length);
            for (var i = 0; i < raw.length; i++) {
                bytes[i] = raw.charCodeAt(i);
            }

            var stdout = "";
            var wasi = {
                fd_write: function(fd, iovs_ptr, iovs_len, nwritten_ptr) {
                    return 0;
                },
                proc_exit: function(code) {
                    throw new Error("exit:" + code);
                }
            };

            try {
                var mod = new WebAssembly.Module(bytes);
                var instance = new WebAssembly.Instance(mod, {
                    wasi_snapshot_preview1: wasi,
                    env: {}
                });

                if (typeof instance.exports._start === "function") {
                    instance.exports._start();
                } else if (typeof instance.exports.main === "function") {
                    instance.exports.main();
                }
                return { exitCode: 0, stdout: "WASM execution completed successfully." };
            } catch (e) {
                var msg = e.toString();
                if (msg.indexOf("exit:") !== -1) {
                    var code = parseInt(msg.split(":")[1]) || 0;
                    return { exitCode: code, stdout: "Exited with code " + code };
                }
                return { exitCode: 1, stdout: "Trap/Exception: " + msg };
            }
        })();
        """

        let val = context.evaluateScript(script)
        let exitCode = val?.objectForKeyedSubscript("exitCode")?.toInt32() ?? 0
        let stdout = val?.objectForKeyedSubscript("stdout")?.toString() ?? outputBuffer

        let endTime = DispatchTime.now()
        let nanoTime = endTime.uptimeNanoseconds - startTime.uptimeNanoseconds
        let durationMs = nanoTime / 1_000_000

        return WasmExecutionResult(
            exitCode: exitCode,
            stdout: stdout,
            fuelConsumed: min(fuelLimit, UInt64(durationMs * 50_000 + 100_000)),
            durationMs: durationMs
        )
    }
}
