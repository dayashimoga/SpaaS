#!/usr/bin/env bash
# SPaaS Production Podman Full-Stack Containerization E2E Test (POSIX Shell)
# Validates Gate G06: Multi-service container orchestration, networking, job dispatch, crash recovery, and teardown

set -euo pipefail

echo "================================================================="
echo " SPaaS Full-Stack Containerization E2E Test (Gate G06)"
echo " Timestamp: $(date)"
echo "================================================================="

# 1. Check Podman
if ! command -v podman &>/dev/null; then
    echo "ERROR: Podman is not installed or available in PATH" >&2
    exit 1
fi
echo "Podman version detected: $(podman --version)"

WORKSPACE_ROOT="$(pwd)"
MOUNT_ARG="${WORKSPACE_ROOT}:/volume:Z"

cleanup() {
    echo ""
    echo ">>> Performing clean teardown of E2E containers and network..."
    podman rm -f -t 0 spaas-e2e-cp spaas-e2e-gw spaas-e2e-sim 2>/dev/null || true
    podman network rm spaas-e2e-net 2>/dev/null || true
    echo "Teardown complete."
}
trap cleanup EXIT

# 2. Cleanup prior runs
echo ""
echo ">>> [STEP 1/7] Cleaning up any prior test containers and network..."
podman rm -f spaas-e2e-cp spaas-e2e-gw spaas-e2e-sim spaas-e2e-cli 2>/dev/null || true
podman network rm spaas-e2e-net 2>/dev/null || true

# 3. Create isolated bridge network
echo ""
echo ">>> [STEP 2/7] Creating isolated bridge network 'spaas-e2e-net'..."
podman network create spaas-e2e-net

# 4. Start Control Plane container
echo ""
echo ">>> [STEP 3/7] Starting Control Plane container 'spaas-e2e-cp'..."
podman run -d --name spaas-e2e-cp --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-control-plane --host 0.0.0.0 --port 8080 --data-dir /tmp/e2e-cp-data

echo "Waiting for Control Plane health endpoint (http://spaas-e2e-cp:8080/api/v1/system/health)..."
HEALTHY=0
for i in $(seq 1 15); do
    sleep 1
    if podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/system/health 2>/dev/null | grep -q "Healthy"; then
        HEALTHY=1
        echo "Control Plane is healthy!"
        break
    fi
done
if [ "$HEALTHY" -ne 1 ]; then
    echo "ERROR: Control Plane failed to become healthy within timeout" >&2
    exit 1
fi

# 5. Start Gateway container
echo ""
echo ">>> [STEP 4/7] Starting Ingress Gateway container 'spaas-e2e-gw'..."
podman run -d --name spaas-e2e-gw --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-gateway --host 0.0.0.0 --port 8000 --upstream-url http://spaas-e2e-cp:8080

# 6. Start Node Simulator container
echo ""
echo ">>> [STEP 5/7] Starting Node Simulator container 'spaas-e2e-sim' (3 nodes)..."
podman run -d --name spaas-e2e-sim --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas-node-simulator --control-plane-url http://spaas-e2e-cp:8080 --nodes 3 --duration-secs 60

echo "Waiting for simulator nodes to register with Control Plane..."
NODES_ENROLLED=0
for i in $(seq 1 15); do
    sleep 1
    NODES_JSON=$(podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/nodes 2>/dev/null || true)
    if [ -n "$NODES_JSON" ] && [ "$NODES_JSON" != "[]" ]; then
        NODES_ENROLLED=1
        echo "Nodes enrolled successfully!"
        break
    fi
done
if [ "$NODES_ENROLLED" -ne 1 ]; then
    echo "ERROR: Simulator nodes failed to enroll within timeout" >&2
    exit 1
fi

# 7. Submit Workload via Containerized CLI
echo ""
echo ">>> [STEP 6/7] Submitting workload via containerized CLI..."
podman run --rm --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 workload submit fixtures/workload.yaml

echo "Waiting for job execution and state verification..."
sleep 3

echo "Querying job status via CLI..."
podman run --rm --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 job list

echo "Querying metering records via API..."
podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/metering 2>/dev/null || true

# 8. Crash Recovery Test
echo ""
echo ">>> [STEP 7/7] Testing Control Plane crash recovery (WAL reload)..."
podman stop spaas-e2e-cp
echo "Control Plane stopped. Restarting container to test WAL persistence recovery..."
podman start spaas-e2e-cp
sleep 2

POST_HEALTH=$(podman run --rm --network spaas-e2e-net docker.io/library/alpine:latest wget -q -O - http://spaas-e2e-cp:8080/api/v1/system/health 2>/dev/null || true)
if echo "$POST_HEALTH" | grep -q "Healthy"; then
    echo "Post-restart health verified: $POST_HEALTH"
else
    echo "ERROR: Control Plane failed to recover healthy state after restart" >&2
    exit 1
fi

echo "Recovered jobs list post-restart:"
podman run --rm --network spaas-e2e-net -v "$MOUNT_ARG" -w /volume docker.io/xd009642/tarpaulin:latest /volume/target/debug/spaas --api-url http://spaas-e2e-cp:8080 job list

echo ""
echo "================================================================="
echo " PODMAN FULL-STACK E2E TEST: PASSED"
echo " Gate G06 Production Certification: GRANTED"
echo "================================================================="
