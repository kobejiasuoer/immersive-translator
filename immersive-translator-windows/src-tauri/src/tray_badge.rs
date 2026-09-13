//! 托盘图标角标：在默认应用图标右上角叠加红色圆点 + 到期数（白字）。
//!
//! 不引图形依赖：直接在 tauri 默认窗口图标的 RGBA 上做像素合成。
//! 数字用内置 3×5 点阵字体放大绘制；due=0 时返回原图。

use tauri::image::Image;

/// 3×5 点阵数字（行从高位到低位：0b111 = 三个像素亮）。
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b010, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

const BADGE_RGB: [u8; 3] = [224, 67, 64]; // 与 --err #e5484d 接近的托盘红

/// 合成角标。返回新的 RGBA 缓冲（due = 0 时原样返回拷贝）。
pub fn compose_badge(base_rgba: &[u8], width: u32, height: u32, due: u32) -> Vec<u8> {
    let mut rgba = base_rgba.to_vec();
    if due == 0 || width == 0 || height == 0 {
        return rgba;
    }
    let w = width as usize;
    let h = height as usize;
    if rgba.len() < w * h * 4 {
        return rgba;
    }
    let min_side = w.min(h) as f32;
    let cx = w as f32 * 0.72;
    let cy = h as f32 * 0.24;
    let radius = min_side * 0.26;

    // 1) 红色圆（带 1 像素级抗锯齿）
    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            let edge = radius;
            if dist <= edge {
                let cover = if dist >= edge - 1.0 { edge - dist } else { 1.0 };
                let alpha = (cover.clamp(0.0, 1.0) * 255.0) as u32;
                if alpha == 0 {
                    continue;
                }
                let idx = (y * w + x) * 4;
                blend_pixel(&mut rgba, idx, BADGE_RGB[0], BADGE_RGB[1], BADGE_RGB[2], alpha);
            }
        }
    }

    // 2) 白色数字（最多 3 位，>999 显示 999）
    let text = if due > 999 { "999".to_string() } else { due.to_string() };
    let len = text.len();
    let scale = ((radius * 1.35) / 5.0).floor().max(1.0) as usize; // 数字高 ≈ 1.35r（5 行点阵）
    let digit_w = 3 * scale;
    let total_w = digit_w * len + scale * (len.saturating_sub(1));
    let start_x = (cx as isize) - (total_w as isize) / 2;
    let start_y = (cy as isize) - (5 * scale as isize) / 2;
    for (i, ch) in text.chars().enumerate() {
        let glyph = DIGITS[ch.to_digit(10).unwrap_or(0) as usize];
        let ox = start_x + (i * (digit_w + scale)) as isize;
        for (row, bits) in glyph.iter().enumerate() {
            for col in 0..3usize {
                if bits & (0b100 >> col) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        let px = ox + (col * scale + sx) as isize;
                        let py = start_y + (row * scale + sy) as isize;
                        if px < 0 || py < 0 || px >= w as isize || py >= h as isize {
                            continue;
                        }
                        let idx = (py as usize * w + px as usize) * 4;
                        blend_pixel(&mut rgba, idx, 255, 255, 255, 255);
                    }
                }
            }
        }
    }
    rgba
}

fn blend_pixel(rgba: &mut [u8], idx: usize, r: u8, g: u8, b: u8, alpha: u32) {
    let a = alpha.min(255);
    // src-over
    let inv = 255 - a;
    rgba[idx] = ((r as u32 * a + rgba[idx] as u32 * inv) / 255) as u8;
    rgba[idx + 1] = ((g as u32 * a + rgba[idx + 1] as u32 * inv) / 255) as u8;
    rgba[idx + 2] = ((b as u32 * a + rgba[idx + 2] as u32 * inv) / 255) as u8;
    // 目标本身视为不透明
    rgba[idx + 3] = 255;
}

/// 合成托盘图标。base 为默认窗口图标。
pub fn badge_icon(base: &Image<'_>, due: u32) -> Image<'static> {
    let rgba = compose_badge(base.rgba(), base.width(), base.height(), due);
    Image::new_owned(rgba, base.width(), base.height())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_base(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&[90, 100, 240, 255]);
        }
        v
    }

    #[test]
    fn due_zero_keeps_base() {
        let base = solid_base(64, 64);
        assert_eq!(compose_badge(&base, 64, 64, 0), base);
    }

    #[test]
    fn due_draws_red_pixels() {
        let base = solid_base(64, 64);
        let out = compose_badge(&base, 64, 64, 6);
        assert_ne!(out, base);
        // 圆环区域应存在徽标红（圆心被白色数字覆盖，扫全缓冲找红色像素）
        let has_red = out
            .chunks_exact(4)
            .any(|px| px[0] == BADGE_RGB[0] && px[1] == BADGE_RGB[1] && px[2] == BADGE_RGB[2]);
        assert!(has_red, "badge circle should paint BADGE_RGB pixels");
        // 且应存在白色数字像素
        let has_white = out.chunks_exact(4).any(|px| px[0] == 255 && px[1] == 255 && px[2] == 255);
        assert!(has_white, "digits should paint white pixels");
    }

    #[test]
    fn badge_scales_with_icon_size() {
        // 32×32 的小图标也要能画下数字而不 panic
        let base = solid_base(32, 32);
        let out = compose_badge(&base, 32, 32, 128);
        assert_ne!(out, base);
    }
}
