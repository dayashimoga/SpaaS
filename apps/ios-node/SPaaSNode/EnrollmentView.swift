import SwiftUI

public struct EnrollmentView: View {
    @ObservedObject public var workerService: WorkerService
    @State private var pairingCode: String = ""
    @State private var customEndpoint: String = ""
    @State private var isSubmitting: Bool = false
    @State private var errorMessage: String? = nil

    public init(workerService: WorkerService) {
        self.workerService = workerService
    }

    public var body: some View {
        NavigationView {
            Form {
                Section(header: Text("Device Pairing")) {
                    TextField("Enter Pairing Code (e.g. SP-8492)", text: $pairingCode)
                        .autocapitalization(.allCharacters)
                        .disableAutocorrection(true)
                        .font(.system(.body, design: .monospaced))

                    TextField("Control Plane URL (Optional)", text: $customEndpoint)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                        .font(.system(.caption, design: .monospaced))

                    Button(action: performEnrollment) {
                        if isSubmitting {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle())
                        } else {
                            Text("Pair with Fabric")
                                .fontWeight(.semibold)
                        }
                    }
                    .disabled(pairingCode.trimmingCharacters(in: .whitespaces).isEmpty || isSubmitting)
                }

                if let err = errorMessage {
                    Section {
                        Text(err)
                            .foregroundColor(.red)
                            .font(.caption)
                    }
                }

                Section(header: Text("iOS Platform Notice")) {
                    Text("Background execution on iOS is constrained by OS battery policies. For maximum performance and credit yield, enable 'Compute While Charging' and keep your device plugged into AC power.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("SPaaS Node Pairing")
        }
    }

    private func performEnrollment() {
        isSubmitting = true
        errorMessage = nil

        let ep = customEndpoint.isEmpty ? nil : customEndpoint
        workerService.enroll(pairingCode: pairingCode, customEndpoint: ep) { result in
            isSubmitting = false
            switch result {
            case .success:
                workerService.startWorker()
            case .failure(let error):
                errorMessage = error.localizedDescription
            }
        }
    }
}
