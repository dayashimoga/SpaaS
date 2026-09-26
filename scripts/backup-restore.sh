#!/usr/bin/env bash
set -euo pipefail

# SPaaS Disaster Recovery & State Backup/Restore Utility (Linux/macOS)

DATA_DIR="${SPAAS_DATA_DIR:-./data/control-plane}"
BACKUP_DIR="${SPAAS_BACKUP_DIR:-./data/backups}"

mkdir -p "$BACKUP_DIR"

action="${1:-backup}"

case "$action" in
    backup)
        TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
        ARCHIVE_FILE="$BACKUP_DIR/spaas-backup-$TIMESTAMP.tar.gz"
        echo "[INFO] Creating backup of $DATA_DIR to $ARCHIVE_FILE..."
        if [ ! -d "$DATA_DIR" ]; then
            mkdir -p "$DATA_DIR"
        fi
        tar -czf "$ARCHIVE_FILE" -C "$DATA_DIR" .
        SHA256=$(sha256sum "$ARCHIVE_FILE" 2>/dev/null || shasum -a 256 "$ARCHIVE_FILE" | awk '{print $1}')
        echo "[SUCCESS] Backup created successfully: $ARCHIVE_FILE"
        echo "  SHA-256: $SHA256"
        ;;
    list)
        echo "[INFO] Scanning backups in $BACKUP_DIR:"
        ls -lh "$BACKUP_DIR"/spaas-backup-* 2>/dev/null || echo "No backups found."
        ;;
    verify)
        TARGET="${2:-}"
        if [ -z "$TARGET" ]; then
            echo "[ERROR] Missing archive path to verify. Usage: ./backup-restore.sh verify <file>"
            exit 1
        fi
        echo "[INFO] Verifying archive integrity: $TARGET"
        tar -tzf "$TARGET" > /dev/null
        echo "[SUCCESS] Archive is valid and readable."
        ;;
    restore)
        TARGET="${2:-}"
        if [ -z "$TARGET" ]; then
            echo "[ERROR] Missing archive path to restore. Usage: ./backup-restore.sh restore <file>"
            exit 1
        fi
        echo "[WARN] Restoring state will overwrite $DATA_DIR"
        mkdir -p "$DATA_DIR"
        tar -xzf "$TARGET" -C "$DATA_DIR"
        echo "[SUCCESS] State restored to $DATA_DIR"
        ;;
    *)
        echo "Usage: $0 {backup|list|verify <file>|restore <file>}"
        exit 1
        ;;
esac
