use crate::error::SecurityError;
use std::path::{Path, PathBuf};

/// Validates that an identifier (e.g. workload ID, node ID, component name) contains only safe characters
pub fn validate_identifier(id: &str) -> Result<(), SecurityError> {
    if id.is_empty() || id.len() > 128 {
        return Err(SecurityError::IllegalInput(
            "Identifier length must be between 1 and 128 characters".into(),
        ));
    }

    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(SecurityError::IllegalInput(format!(
            "Identifier contains illegal characters: '{id}'"
        )));
    }

    if id.contains("..") {
        return Err(SecurityError::IllegalInput(
            "Identifier cannot contain path traversal sequences ('..')".into(),
        ));
    }

    Ok(())
}

/// Resolves a sandboxed path relative to a base directory, strictly preventing path traversal
pub fn sanitize_sandboxed_path(
    base_dir: &Path,
    relative_path: &str,
) -> Result<PathBuf, SecurityError> {
    if relative_path.contains("..") || relative_path.starts_with('/') || relative_path.starts_with('\\') {
        return Err(SecurityError::IllegalInput(format!(
            "Path traversal attempt rejected: {relative_path}"
        )));
    }

    let joined = base_dir.join(relative_path);
    // Ensure that normalized path stays under base_dir
    let normalized = joined
        .components()
        .collect::<PathBuf>();

    if !normalized.starts_with(base_dir) {
        return Err(SecurityError::IllegalInput(format!(
            "Resolved path escapes sandbox: {normalized:?}"
        )));
    }

    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_identifier_validation() {
        assert!(validate_identifier("node-uuid-1234").is_ok());
        assert!(validate_identifier("workload_v1.0").is_ok());
        assert!(validate_identifier("../etc/passwd").is_err());
        assert!(validate_identifier("bad;command").is_err());
        assert!(validate_identifier("bad`whoami`").is_err());
        assert!(validate_identifier("bad$HOME").is_err());
    }

    #[test]
    fn test_sanitized_sandboxed_path() {
        let base = PathBuf::from("/sandbox/root");
        assert!(sanitize_sandboxed_path(&base, "sub/file.txt").is_ok());
        assert!(sanitize_sandboxed_path(&base, "../escape.txt").is_err());
        assert!(sanitize_sandboxed_path(&base, "/absolute/path").is_err());
    }
}
