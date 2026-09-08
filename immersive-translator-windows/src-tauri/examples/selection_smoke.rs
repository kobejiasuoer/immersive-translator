//! 使用产品代码验证指定窗口的选区，不调用翻译服务。
//! cargo run --example selection_smoke -- <hwnd> <uia|copy> <expected-text>
#![allow(dead_code)]

#[path = "../src/clipboard.rs"]
mod clipboard;
#[path = "../src/uia.rs"]
mod uia;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let hwnd: isize = args
        .get(1)
        .expect("window handle required")
        .parse()
        .unwrap();
    let mode = args.get(2).expect("uia or copy required");
    let expected = args.get(3).expect("expected text required");
    let text = match mode.as_str() {
        "uia" => uia::read_selection_uia(hwnd),
        "copy" => clipboard::read_selection_impl(hwnd),
        _ => panic!("mode must be uia or copy"),
    }
    .expect("selection read failed");
    assert_eq!(&text, expected, "selection differs from fixture");
    println!("PASS: {mode}, {} characters", text.chars().count());
}
