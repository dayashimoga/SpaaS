import SwiftUI

#if !SWIFT_PACKAGE
@main
#endif
public struct SPaaSNodeApp: App {
    @StateObject private var workerService = WorkerService()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            if workerService.isEnrolled {
                MainDashboardView(workerService: workerService)
            } else {
                EnrollmentView(workerService: workerService)
            }
        }
    }
}

struct MainDashboardView: View {
    @ObservedObject var workerService: WorkerService

    var body: some View {
        NavigationView {
            List {
                Section(header: Text("Node Health")) {
                    HStack {
                        Text("Node ID")
                        Spacer()
                        Text(workerService.nodeId)
                            .font(.system(.subheadline, design: .monospaced))
                            .foregroundColor(.secondary)
                    }

                    HStack {
                        Text("Worker Status")
                        Spacer()
                        Text(workerService.isRunning ? "RUNNING" : "PAUSED")
                            .foregroundColor(workerService.isRunning ? .green : .orange)
                            .fontWeight(.bold)
                    }

                    HStack {
                        Text("Activity")
                        Spacer()
                        Text(workerService.statusMessage)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                Section(header: Text("Fabric Telemetry & Credits")) {
                    HStack {
                        Text("Completed Jobs")
                        Spacer()
                        Text("\(workerService.jobsCompleted)")
                            .fontWeight(.semibold)
                    }

                    HStack {
                        Text("Settled TEST CREDITS")
                        Spacer()
                        Text("\(workerService.creditsEarned)")
                            .foregroundColor(.cyan)
                            .fontWeight(.bold)
                    }
                }

                Section {
                    Button(action: {
                        if workerService.isRunning {
                            workerService.stopWorker()
                        } else {
                            workerService.startWorker()
                        }
                    }) {
                        HStack {
                            Spacer()
                            Text(workerService.isRunning ? "Pause Edge Compute" : "Resume Edge Compute")
                                .foregroundColor(workerService.isRunning ? .red : .green)
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle("SPaaS Edge Node")
        }
    }
}
