//! The panel's files live beside the binary, because the daemon serves a panel's files only from the
//! folder its executable sits in. Copying them here means `cargo build --release` leaves a ready
//! registration: the binary and its `assets/` folder in one place, with no manual step after.

use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=assets");
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by cargo"));
    // OUT_DIR is <root>/build/<pkg-hash>/out; the profile folder is three levels up from it.
    let assets = out.join("../../..").join("assets");
    fs::create_dir_all(&assets).expect("the assets folder can be made");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"));
    for name in ["panel.html", "panel.css", "panel.js"] {
        let source = manifest.join("assets").join(name);
        fs::copy(&source, assets.join(name)).expect("the panel asset can be copied");
    }
}
