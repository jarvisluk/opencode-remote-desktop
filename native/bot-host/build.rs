use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    // System dyld shared cache path (required at runtime for @rpath/libswift_Concurrency.dylib
    // when ScreenCaptureKitBridge is built against macOS 12.3).
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    if let Ok(output) = Command::new("xcode-select").arg("-p").output() {
        if output.status.success() {
            let dev_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            for candidate in [
                format!("{dev_dir}/usr/lib/swift/macosx"),
                format!("{dev_dir}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx"),
            ] {
                if Path::new(&candidate).is_dir() {
                    println!("cargo:rustc-link-search=native={candidate}");
                    println!("cargo:rustc-link-arg=-Wl,-rpath,{candidate}");
                }
            }
        }
    }
}
