import Foundation
#if canImport(UIKit)
import UIKit
#endif
import Combine

public final class WorkerService: ObservableObject {
    @Published public var isEnrolled: Bool = false
    @Published public var nodeId: String = ""
    @Published public var authToken: String = ""
    @Published public var endpoint: String = "https://spaas-control-plane.dayashimoga.workers.dev"
    @Published public var isRunning: Bool = false
    @Published public var jobsCompleted: Int = 0
    @Published public var creditsEarned: Int = 0
    @Published public var statusMessage: String = "Idle"

    private let identity = KeychainIdentity()
    private let wasmEngine = WasmEngine()
    private var cancellables = Set<AnyCancellable>()
    private var loopTimer: Timer?

    public init() {
        #if canImport(UIKit)
        UIDevice.current.isBatteryMonitoringEnabled = true
        #endif
        loadStoredCredentials()
    }

    private func loadStoredCredentials() {
        if let savedNodeId = UserDefaults.standard.string(forKey: "spaas_ios_node_id"),
           let savedToken = UserDefaults.standard.string(forKey: "spaas_ios_auth_token") {
            self.nodeId = savedNodeId
            self.authToken = savedToken
            self.isEnrolled = true
            if let savedEndpoint = UserDefaults.standard.string(forKey: "spaas_ios_endpoint") {
                self.endpoint = savedEndpoint
            }
        }
    }

    public func enroll(pairingCode: String, customEndpoint: String? = nil, completion: @escaping (Result<Void, Error>) -> Void) {
        let ep = customEndpoint ?? self.endpoint
        self.endpoint = ep

        let genNodeId = "ios-\(UUID().uuidString.prefix(8).lowercased())"
        #if canImport(UIKit)
        let deviceName = UIDevice.current.name
        #else
        let deviceName = Host.current().localizedName ?? "Apple Mac"
        #endif

        guard let url = URL(string: "\(ep.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/v1/devices/pair") else {
            completion(.failure(NSError(domain: "SPaaS", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid endpoint URL"])))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let payload: [String: Any] = [
            "pairing_token": pairingCode.trimmingCharacters(in: .whitespacesAndNewlines),
            "node_id": genNodeId,
            "device_name": deviceName,
            "device_type": "Phone",
            "public_key": identity.publicKeyHex
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                DispatchQueue.main.async { completion(.failure(error)) }
                return
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let token = json["auth_token"] as? String else {
                let err = NSError(domain: "SPaaS", code: 500, userInfo: [NSLocalizedDescriptionKey: "Invalid server response"])
                DispatchQueue.main.async { completion(.failure(err)) }
                return
            }

            DispatchQueue.main.async {
                self?.nodeId = json["node_id"] as? String ?? genNodeId
                self?.authToken = token
                self?.isEnrolled = true
                UserDefaults.standard.set(self?.nodeId, forKey: "spaas_ios_node_id")
                UserDefaults.standard.set(token, forKey: "spaas_ios_auth_token")
                UserDefaults.standard.set(ep, forKey: "spaas_ios_endpoint")
                completion(.success(()))
            }
        }.resume()
    }

    public func startWorker() {
        guard isEnrolled, !isRunning else { return }
        isRunning = true
        statusMessage = "Online — polling for edge compute workloads"

        loopTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    public func stopWorker() {
        isRunning = false
        loopTimer?.invalidate()
        loopTimer = nil
        statusMessage = "Worker paused"
    }

    private func tick() {
        sendHeartbeat()
        pollForJob()
    }

    private func sendHeartbeat() {
        guard let url = URL(string: "\(endpoint)/api/v1/nodes/heartbeat") else { return }

        #if canImport(UIKit)
        let batteryLevel = Int(max(0, UIDevice.current.batteryLevel) * 100)
        let batteryState = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full ? "ChargingAc" : "Discharging"
        #else
        let batteryLevel = 100
        let batteryState = "ChargingAc"
        #endif

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

        let payload: [String: Any] = [
            "node_id": nodeId,
            "telemetry": [
                "battery_pct": batteryLevel,
                "charging_state": batteryState,
                "thermal_status": "None",
                "network_type": "WifiUnmetered",
                "reliability_score": 1.0,
                "round_trip_ping_ms": 35
            ]
        ]

        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req).resume()
    }

    private func pollForJob() {
        guard let url = URL(string: "\(endpoint)/api/v1/nodes/\(nodeId)/poll") else { return }

        var req = URLRequest(url: url)
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

        URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            guard let self = self, let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let job = json["job"] as? [String: Any],
                  let jobId = job["job_id"] as? String,
                  let fencingToken = job["fencing_token"] as? String else {
                return
            }

            DispatchQueue.main.async {
                self.statusMessage = "Executing job \(jobId)..."
            }

            // Minimal WASI test bytecode
            let dummyWasm = Data([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
            let result = self.wasmEngine.execute(wasmBytes: dummyWasm)

            self.submitJobResult(jobId: jobId, fencingToken: fencingToken, result: result)
        }.resume()
    }

    private func submitJobResult(jobId: String, fencingToken: String, result: WasmExecutionResult) {
        guard let url = URL(string: "\(endpoint)/api/v1/nodes/results") else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

        let payload: [String: Any] = [
            "job_id": jobId,
            "node_id": nodeId,
            "fencing_token": fencingToken,
            "exit_code": result.exitCode,
            "stdout": result.stdout,
            "fuel_used": result.fuelConsumed,
            "duration_ms": result.durationMs
        ]

        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            if let httpRes = response as? HTTPURLResponse, httpRes.statusCode == 200 {
                DispatchQueue.main.async {
                    self?.jobsCompleted += 1
                    self?.creditsEarned += 10
                    self?.statusMessage = "Job \(jobId) settled (+10 TEST CREDITS)"
                }
            }
        }.resume()
    }
}
