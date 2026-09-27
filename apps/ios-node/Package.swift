// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SPaaSNode",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "SPaaSNode",
            targets: ["SPaaSNode"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "SPaaSNode",
            path: "SPaaSNode",
            resources: []
        ),
        .testTarget(
            name: "SPaaSNodeTests",
            dependencies: ["SPaaSNode"],
            path: "Tests"
        ),
    ]
)
