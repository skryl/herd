#!/usr/bin/env python3
import argparse
import pathlib
import re
import sys

from PIL import Image, ImageDraw, ImageFont

ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def strip_ansi(value: str) -> str:
    return ANSI_ESCAPE_RE.sub("", value)


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


def render_text_file_to_png(
    source_path: pathlib.Path,
    output_path: pathlib.Path,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> None:
    lines = source_path.read_text(encoding="utf-8").splitlines()
    lines = [strip_ansi(line) for line in lines]
    if not lines:
        lines = [""]

    max_cols = max(len(line) for line in lines)
    probe = "M"
    bbox = font.getbbox(probe)
    char_w = max(1, bbox[2] - bbox[0])
    char_h = max(1, bbox[3] - bbox[1] + 3)

    padding_x = 18
    padding_y = 14
    width = max(320, padding_x * 2 + (max_cols * char_w))
    height = max(120, padding_y * 2 + (len(lines) * char_h))

    image = Image.new("RGB", (width, height), "#0b1220")
    draw = ImageDraw.Draw(image)

    y = padding_y
    for line in lines:
        draw.text((padding_x, y), line, fill="#dce6f5", font=font)
        y += char_h

    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render TUI text snapshots into PNG files.")
    parser.add_argument("--input", required=True, help="Directory with *.txt raw snapshots.")
    parser.add_argument("--output", required=True, help="Directory for generated PNG files.")
    parser.add_argument("--font-size", type=int, default=15, help="Monospace font size.")
    args = parser.parse_args()

    input_dir = pathlib.Path(args.input)
    output_dir = pathlib.Path(args.output)
    if not input_dir.exists():
        print(f"error: input directory does not exist: {input_dir}", file=sys.stderr)
        return 1

    txt_files = sorted(input_dir.glob("*.txt"))
    if not txt_files:
        print(f"error: no .txt snapshots found in {input_dir}", file=sys.stderr)
        return 1

    font = load_mono_font(args.font_size)
    for txt_file in txt_files:
        output_file = output_dir / f"{txt_file.stem}.png"
        render_text_file_to_png(txt_file, output_file, font)
        print(f"generated {output_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
