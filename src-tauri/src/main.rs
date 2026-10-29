// Évite la console supplémentaire sous Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lernoviq_lib::run()
}
