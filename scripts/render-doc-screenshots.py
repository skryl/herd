#!/usr/bin/env python3
import argparse
import json
import pathlib
import sys
from typing import Any

from PIL import Image, ImageDraw, ImageFont

DEFAULT_BG = (11, 18, 32)
DEFAULT_FG = (220, 230, 245)
DEFAULT_GIF_SEQUENCE = [
    ("tui_overview", 1200),
    ("tui_settings_overlay", 1200),
    ("tui_input_mode", 1200),
    ("tui_herder_log_filter", 1200),
    ("tui_overview", 1400),
]

# ratatui modifier bit flags.
MOD_BOLD = 0x0001
MOD_UNDERLINED = 0x0008
MOD_REVERSED = 0x0040
MOD_HIDDEN = 0x0080

NAMED_COLORS: dict[str, tuple[int, int, int]] = {
    "reset": DEFAULT_FG,
    "black": (12, 12, 12),
    "red": (205, 49, 49),
    "green": (13, 188, 121),
    "yellow": (229, 229, 16),
    "blue": (36, 114, 200),
    "magenta": (188, 63, 188),
    "cyan": (17, 168, 205),
    "gray": (204, 204, 204),
    "dark_gray": (128, 128, 128),
    "light_red": (241, 76, 76),
    "light_green": (35, 209, 139),
    "light_yellow": (245, 245, 67),
    "light_blue": (59, 142, 234),
    "light_magenta": (214, 112, 214),
    "light_cyan": (41, 184, 219),
    "white": (242, 242, 242),
}


def clamp(value: int) -> int:
    return max(0, min(255, value))


def brighten(color: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(clamp(int(component * factor)) for component in color)


def xterm_index_to_rgb(index: int) -> tuple[int, int, int]:
    # Standard xterm palette.
    table = [
        (0, 0, 0),
        (205, 0, 0),
        (0, 205, 0),
        (205, 205, 0),
        (0, 0, 238),
        (205, 0, 205),
        (0, 205, 205),
        (229, 229, 229),
        (127, 127, 127),
        (255, 0, 0),
        (0, 255, 0),
        (255, 255, 0),
        (92, 92, 255),
        (255, 0, 255),
        (0, 255, 255),
        (255, 255, 255),
    ]
    if index < 0:
        return (0, 0, 0)
    if index <= 15:
        return table[index]
    if 16 <= index <= 231:
        idx = index - 16
        r = idx // 36
        g = (idx % 36) // 6
        b = idx % 6
        def level(component: int) -> int:
            return 0 if component == 0 else 55 + component * 40
        return (level(r), level(g), level(b))
    if 232 <= index <= 255:
        gray = 8 + (index - 232) * 10
        return (gray, gray, gray)
    return (0, 0, 0)


def decode_color(value: Any, is_background: bool) -> tuple[int, int, int]:
    if isinstance(value, str):
        if value == "reset":
            return DEFAULT_BG if is_background else DEFAULT_FG
        return NAMED_COLORS.get(value, DEFAULT_BG if is_background else DEFAULT_FG)
    if isinstance(value, dict):
        if "rgb" in value:
            rgb = value["rgb"]
            if isinstance(rgb, list) and len(rgb) == 3:
                return (clamp(int(rgb[0])), clamp(int(rgb[1])), clamp(int(rgb[2])))
        if "indexed" in value:
            return xterm_index_to_rgb(int(value["indexed"]))
    return DEFAULT_BG if is_background else DEFAULT_FG


def load_mono_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/SFNSMono.ttf",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for path in candidates:
        font_path = pathlib.Path(path)
        if not font_path.exists():
            continue
        try:
            return ImageFont.truetype(str(font_path), size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_snapshot_json_to_png(
    source_path: pathlib.Path,
    output_path: pathlib.Path,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    width_cells = int(payload.get("width", 0))
    height_cells = int(payload.get("height", 0))
    cells: list[dict[str, Any]] = payload.get("cells", [])

    if width_cells <= 0 or height_cells <= 0:
        raise ValueError(f"invalid snapshot dimensions in {source_path}")
    if len(cells) < width_cells * height_cells:
        raise ValueError(
            f"snapshot has insufficient cells in {source_path}: "
            f"expected {width_cells * height_cells}, got {len(cells)}"
        )

    probe = "M"
    bbox = font.getbbox(probe)
    char_w = max(1, bbox[2] - bbox[0])
    char_h = max(1, bbox[3] - bbox[1] + 3)

    padding_x = 18
    padding_y = 14
    image_width = max(320, padding_x * 2 + (width_cells * char_w))
    image_height = max(120, padding_y * 2 + (height_cells * char_h))

    image = Image.new("RGB", (image_width, image_height), DEFAULT_BG)
    draw = ImageDraw.Draw(image)

    for row in range(height_cells):
        for col in range(width_cells):
            idx = row * width_cells + col
            cell = cells[idx]
            symbol = str(cell.get("symbol", " "))
            if symbol == "":
                symbol = " "
            modifiers = int(cell.get("modifier_bits", 0))
            fg = decode_color(cell.get("fg", "reset"), is_background=False)
            bg = decode_color(cell.get("bg", "reset"), is_background=True)

            if modifiers & MOD_REVERSED:
                fg, bg = bg, fg
            if modifiers & MOD_BOLD:
                fg = brighten(fg, 1.12)

            x = padding_x + col * char_w
            y = padding_y + row * char_h
            draw.rectangle([x, y, x + char_w, y + char_h], fill=bg)

            if not (modifiers & MOD_HIDDEN):
                draw.text((x, y), symbol, fill=fg, font=font)
            if modifiers & MOD_UNDERLINED:
                underline_y = y + char_h - 2
                draw.line((x, underline_y, x + char_w - 1, underline_y), fill=fg, width=1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def build_happy_path_gif(output_dir: pathlib.Path, gif_name: str) -> None:
    frame_paths = []
    durations = []
    for stem, duration in DEFAULT_GIF_SEQUENCE:
        frame_path = output_dir / f"{stem}.png"
        if not frame_path.exists():
            raise FileNotFoundError(
                f"missing frame for happy path gif: {frame_path}"
            )
        frame_paths.append(frame_path)
        durations.append(duration)

    frames = [Image.open(frame_path).convert("RGB") for frame_path in frame_paths]
    try:
        gif_path = output_dir / gif_name
        frames[0].save(
            gif_path,
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=0,
            optimize=False,
            disposal=2,
        )
    finally:
        for frame in frames:
            frame.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render styled TUI snapshot JSON files into PNG screenshots."
    )
    parser.add_argument("--input", required=True, help="Directory with *.json raw snapshots.")
    parser.add_argument("--output", required=True, help="Directory for generated PNG files.")
    parser.add_argument("--font-size", type=int, default=15, help="Monospace font size.")
    parser.add_argument(
        "--gif-name",
        default="happy_path.gif",
        help="Filename for generated happy path GIF.",
    )
    parser.add_argument(
        "--no-gif",
        action="store_true",
        help="Disable happy path GIF generation.",
    )
    args = parser.parse_args()

    input_dir = pathlib.Path(args.input)
    output_dir = pathlib.Path(args.output)
    if not input_dir.exists():
        print(f"error: input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    json_files = sorted(input_dir.glob("*.json"))
    if not json_files:
        print(f"error: no .json snapshots found in {input_dir}", file=sys.stderr)
        return 1

    font = load_mono_font(args.font_size)
    for json_file in json_files:
        output_file = output_dir / f"{json_file.stem}.png"
        render_snapshot_json_to_png(json_file, output_file, font)
        print(f"generated {output_file}")
    if not args.no_gif:
        build_happy_path_gif(output_dir, args.gif_name)
        print(f"generated {output_dir / args.gif_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
