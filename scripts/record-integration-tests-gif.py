#!/usr/bin/env python3
import argparse
import os
import pathlib
import pty
import re
import select
import shlex
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import List

from PIL import Image, ImageDraw, ImageFont

ANSI_ESCAPE_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


@dataclass
class FrameState:
    image: Image.Image
    duration_ms: int


class TerminalLogBuffer:
    def __init__(self, width: int, height: int) -> None:
        self.width = max(20, width)
        self.height = max(5, height)
        self.lines: List[str] = []
        self.current = ""
        self._in_escape = False
        self._escape_buf = ""

    def _push_line(self, text: str) -> None:
        if not text:
            self.lines.append("")
        else:
            while len(text) > self.width:
                self.lines.append(text[: self.width])
                text = text[self.width :]
            self.lines.append(text)
        while len(self.lines) > 8000:
            self.lines = self.lines[1000:]

    def feed(self, chunk: str) -> None:
        # Pre-strip standard ANSI chunks quickly; still handle \r, \n, \b manually.
        chunk = ANSI_ESCAPE_RE.sub("", chunk)
        for ch in chunk:
            if ch == "\x1b":
                self._in_escape = True
                self._escape_buf = ch
                continue
            if self._in_escape:
                self._escape_buf += ch
                # Fallback escape state clear on final-byte range.
                if "@" <= ch <= "~":
                    self._in_escape = False
                    self._escape_buf = ""
                continue
            if ch == "\r":
                self.current = ""
                continue
            if ch == "\n":
                self._push_line(self.current)
                self.current = ""
                continue
            if ch == "\b":
                self.current = self.current[:-1]
                continue
            if ch == "\t":
                spaces = 4 - (len(self.current) % 4)
                self.current += " " * spaces
                continue
            # Drop other control chars.
            if ord(ch) < 32:
                continue
            self.current += ch
            if len(self.current) > self.width:
                self._push_line(self.current[: self.width])
                self.current = self.current[self.width :]

    def viewport(self) -> List[str]:
        combined = self.lines + [self.current]
        if not combined:
            combined = [""]
        tail = combined[-self.height :]
        if len(tail) < self.height:
            tail = [""] * (self.height - len(tail)) + tail
        return tail


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
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


def render_frame(
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    width_chars: int,
    height_chars: int,
    command_label: str,
    elapsed_secs: float,
    exit_code: int | None,
    viewport_lines: List[str],
) -> Image.Image:
    probe = "M"
    bbox = font.getbbox(probe)
    char_w = max(1, bbox[2] - bbox[0])
    char_h = max(1, bbox[3] - bbox[1] + 3)

    pad_x = 16
    pad_y = 12
    header_h = char_h * 2 + 8
    width_px = pad_x * 2 + width_chars * char_w
    height_px = pad_y * 2 + header_h + height_chars * char_h

    image = Image.new("RGB", (width_px, height_px), (6, 10, 24))
    draw = ImageDraw.Draw(image)

    draw.rectangle([(0, 0), (width_px, header_h + pad_y)], fill=(12, 22, 40))
    draw.text(
        (pad_x, pad_y),
        f"herd integration suite recording",
        fill=(121, 203, 255),
        font=font,
    )
    status = f"elapsed: {elapsed_secs:5.1f}s"
    if exit_code is not None:
        status += f"   exit: {exit_code}"
    draw.text((pad_x, pad_y + char_h + 2), status, fill=(170, 220, 255), font=font)

    command_text = command_label
    if len(command_text) > width_chars:
        command_text = command_text[: width_chars - 3] + "..."
    draw.text((pad_x, header_h - 2), command_text, fill=(138, 255, 190), font=font)

    y = header_h + pad_y + 4
    for line in viewport_lines:
        draw.text((pad_x, y), line, fill=(220, 233, 248), font=font)
        y += char_h
    return image


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run integration tests and capture a terminal recording GIF."
    )
    parser.add_argument(
        "--command",
        default="./scripts/run-integration-tests.sh --tier full",
        help="Command to run for recording.",
    )
    parser.add_argument(
        "--output",
        default="docs/screenshots/integration_suite.gif",
        help="Path to output GIF.",
    )
    parser.add_argument("--width", type=int, default=150, help="Viewport width in characters.")
    parser.add_argument("--height", type=int, default=42, help="Viewport height in lines.")
    parser.add_argument(
        "--font-size", type=int, default=15, help="Monospace font size for rendering."
    )
    parser.add_argument(
        "--frame-interval-ms",
        type=int,
        default=200,
        help="Minimum milliseconds between rendered frames.",
    )
    parser.add_argument(
        "--poll-ms",
        type=int,
        default=40,
        help="PTY poll interval milliseconds.",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=2000,
        help="Safety cap for generated frames.",
    )
    parser.add_argument(
        "--tail-hold-ms",
        type=int,
        default=1800,
        help="Final pause duration at end of GIF.",
    )
    parser.add_argument(
        "--cwd",
        default=".",
        help="Working directory for running the command.",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output_path = pathlib.Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = shlex.split(args.command)
    if not command:
        print("error: command is empty", file=sys.stderr)
        return 1

    master_fd, slave_fd = pty.openpty()
    try:
        process = subprocess.Popen(
            command,
            cwd=args.cwd,
            stdin=subprocess.DEVNULL,
            stdout=slave_fd,
            stderr=slave_fd,
            env=os.environ.copy(),
            close_fds=True,
        )
    finally:
        os.close(slave_fd)

    font = load_font(args.font_size)
    buffer = TerminalLogBuffer(args.width, args.height)
    frames: List[FrameState] = []

    start = time.monotonic()
    last_frame_at = start
    last_emit_at = start

    def emit_frame(force: bool = False) -> None:
        nonlocal last_frame_at, last_emit_at
        now = time.monotonic()
        elapsed_ms = int((now - last_emit_at) * 1000)
        if not force and elapsed_ms < args.frame_interval_ms:
            return
        if len(frames) >= args.max_frames:
            return
        image = render_frame(
            font=font,
            width_chars=args.width,
            height_chars=args.height,
            command_label=args.command,
            elapsed_secs=now - start,
            exit_code=None,
            viewport_lines=buffer.viewport(),
        )
        duration = max(30, elapsed_ms if frames else args.frame_interval_ms)
        frames.append(FrameState(image=image, duration_ms=duration))
        last_frame_at = now
        last_emit_at = now

    try:
        while True:
            timeout = args.poll_ms / 1000.0
            ready, _, _ = select.select([master_fd], [], [], timeout)
            now = time.monotonic()
            if ready:
                try:
                    payload = os.read(master_fd, 65536)
                except OSError:
                    payload = b""
                if payload:
                    buffer.feed(payload.decode("utf-8", errors="replace"))
                    emit_frame(force=False)
                else:
                    if process.poll() is not None:
                        break
            else:
                # Keep advancing frame timing during long quiet windows.
                if now - last_frame_at >= (args.frame_interval_ms / 1000.0):
                    emit_frame(force=False)
                if process.poll() is not None:
                    break
    finally:
        os.close(master_fd)

    exit_code = process.wait()
    end_time = time.monotonic()

    # Final frame with exit status.
    final_image = render_frame(
        font=font,
        width_chars=args.width,
        height_chars=args.height,
        command_label=args.command,
        elapsed_secs=end_time - start,
        exit_code=exit_code,
        viewport_lines=buffer.viewport(),
    )
    final_duration = max(60, int((end_time - last_emit_at) * 1000))
    frames.append(FrameState(image=final_image, duration_ms=final_duration))
    frames.append(
        FrameState(
            image=final_image.copy(),
            duration_ms=max(300, args.tail_hold_ms),
        )
    )

    if not frames:
        print("error: no frames captured", file=sys.stderr)
        return 1

    base = frames[0].image
    rest = [item.image for item in frames[1:]]
    durations = [item.duration_ms for item in frames]
    base.save(
        output_path,
        save_all=True,
        append_images=rest,
        duration=durations,
        loop=0,
        optimize=False,
        disposal=2,
    )
    print(f"recorded {output_path}")
    print(f"command exit code: {exit_code}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
