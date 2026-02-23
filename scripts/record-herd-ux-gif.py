#!/usr/bin/env python3
import argparse
import pathlib
import random
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import List, Tuple

from PIL import Image, ImageDraw, ImageFont


DEFAULT_BG = (11, 18, 32)
DEFAULT_FG = (220, 230, 245)


@dataclass
class StyleState:
    fg: Tuple[int, int, int] | None = None
    bg: Tuple[int, int, int] | None = None
    bold: bool = False
    underline: bool = False
    inverse: bool = False
    hidden: bool = False

    def clone(self) -> "StyleState":
        return StyleState(
            fg=self.fg,
            bg=self.bg,
            bold=self.bold,
            underline=self.underline,
            inverse=self.inverse,
            hidden=self.hidden,
        )


@dataclass
class FrameState:
    image: Image.Image
    duration_ms: int


def clamp(value: int) -> int:
    return max(0, min(255, value))


def brighten(color: Tuple[int, int, int], factor: float) -> Tuple[int, int, int]:
    return tuple(clamp(int(component * factor)) for component in color)


def xterm_index_to_rgb(index: int) -> Tuple[int, int, int]:
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
    if index <= 15:
        return table[max(0, index)]
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


def ansi_fg(code: int) -> Tuple[int, int, int] | None:
    mapping = {
        30: (12, 12, 12),
        31: (205, 49, 49),
        32: (13, 188, 121),
        33: (229, 229, 16),
        34: (36, 114, 200),
        35: (188, 63, 188),
        36: (17, 168, 205),
        37: (204, 204, 204),
        90: (128, 128, 128),
        91: (241, 76, 76),
        92: (35, 209, 139),
        93: (245, 245, 67),
        94: (59, 142, 234),
        95: (214, 112, 214),
        96: (41, 184, 219),
        97: (242, 242, 242),
    }
    return mapping.get(code)


def ansi_bg(code: int) -> Tuple[int, int, int] | None:
    mapping = {
        40: (12, 12, 12),
        41: (205, 49, 49),
        42: (13, 188, 121),
        43: (229, 229, 16),
        44: (36, 114, 200),
        45: (188, 63, 188),
        46: (17, 168, 205),
        47: (204, 204, 204),
        100: (128, 128, 128),
        101: (241, 76, 76),
        102: (35, 209, 139),
        103: (245, 245, 67),
        104: (59, 142, 234),
        105: (214, 112, 214),
        106: (41, 184, 219),
        107: (242, 242, 242),
    }
    return mapping.get(code)


def apply_sgr(codes: List[int], state: StyleState) -> None:
    if not codes:
        codes = [0]
    i = 0
    while i < len(codes):
        code = codes[i]
        if code == 0:
            state.fg = None
            state.bg = None
            state.bold = False
            state.underline = False
            state.inverse = False
            state.hidden = False
        elif code == 1:
            state.bold = True
        elif code == 22:
            state.bold = False
        elif code == 4:
            state.underline = True
        elif code == 24:
            state.underline = False
        elif code == 7:
            state.inverse = True
        elif code == 27:
            state.inverse = False
        elif code == 8:
            state.hidden = True
        elif code == 28:
            state.hidden = False
        elif code == 39:
            state.fg = None
        elif code == 49:
            state.bg = None
        elif 30 <= code <= 37 or 90 <= code <= 97:
            state.fg = ansi_fg(code)
        elif 40 <= code <= 47 or 100 <= code <= 107:
            state.bg = ansi_bg(code)
        elif code in (38, 48):
            is_fg = code == 38
            if i + 1 < len(codes) and codes[i + 1] == 5 and i + 2 < len(codes):
                color = xterm_index_to_rgb(codes[i + 2])
                if is_fg:
                    state.fg = color
                else:
                    state.bg = color
                i += 2
            elif (
                i + 1 < len(codes)
                and codes[i + 1] == 2
                and i + 4 < len(codes)
            ):
                color = (
                    clamp(codes[i + 2]),
                    clamp(codes[i + 3]),
                    clamp(codes[i + 4]),
                )
                if is_fg:
                    state.fg = color
                else:
                    state.bg = color
                i += 4
        i += 1


def parse_ansi_lines(text: str, width: int, height: int) -> List[List[Tuple[str, StyleState]]]:
    lines: List[List[Tuple[str, StyleState]]] = []
    current: List[Tuple[str, StyleState]] = []
    state = StyleState()
    i = 0
    text_len = len(text)

    def flush_line() -> None:
        nonlocal current
        if len(current) > width:
            current = current[:width]
        if len(current) < width:
            pad_style = state.clone()
            current.extend([(" ", pad_style) for _ in range(width - len(current))])
        lines.append(current)
        current = []

    while i < text_len:
        ch = text[i]
        if ch == "\x1b" and i + 1 < text_len and text[i + 1] == "[":
            i += 2
            seq_start = i
            while i < text_len and not ("@" <= text[i] <= "~"):
                i += 1
            if i >= text_len:
                break
            final = text[i]
            payload = text[seq_start:i]
            if final == "m":
                parts = [part for part in payload.split(";") if part != ""]
                try:
                    codes = [int(part) for part in parts]
                except ValueError:
                    codes = []
                apply_sgr(codes, state)
            i += 1
            continue
        if ch == "\n":
            flush_line()
            i += 1
            continue
        if ch == "\r":
            current = []
            i += 1
            continue
        if ch == "\t":
            spaces = 4 - (len(current) % 4)
            for _ in range(spaces):
                if len(current) < width:
                    current.append((" ", state.clone()))
            i += 1
            continue
        if ord(ch) < 32:
            i += 1
            continue
        if len(current) < width:
            current.append((ch, state.clone()))
        i += 1

    if current or not lines:
        flush_line()

    if len(lines) > height:
        lines = lines[-height:]
    if len(lines) < height:
        empty_style = StyleState()
        empty_line = [(" ", empty_style) for _ in range(width)]
        lines = [empty_line for _ in range(height - len(lines))] + lines
    return lines


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


def render_terminal_frame(
    lines: List[List[Tuple[str, StyleState]]],
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    title: str,
) -> Image.Image:
    height_cells = len(lines)
    width_cells = len(lines[0]) if lines else 80
    bbox = font.getbbox("M")
    char_w = max(1, bbox[2] - bbox[0])
    char_h = max(1, bbox[3] - bbox[1] + 3)
    pad_x = 16
    pad_y = 12
    header_h = char_h + 10
    image_width = pad_x * 2 + width_cells * char_w
    image_height = pad_y * 2 + header_h + height_cells * char_h

    image = Image.new("RGB", (image_width, image_height), DEFAULT_BG)
    draw = ImageDraw.Draw(image)

    draw.rectangle([(0, 0), (image_width, header_h + pad_y)], fill=(12, 22, 40))
    draw.text((pad_x, pad_y), title, fill=(121, 203, 255), font=font)

    y0 = header_h + pad_y
    for row, line in enumerate(lines):
        y = y0 + row * char_h
        for col, (symbol, style) in enumerate(line):
            x = pad_x + col * char_w
            fg = style.fg or DEFAULT_FG
            bg = style.bg or DEFAULT_BG
            if style.inverse:
                fg, bg = bg, fg
            if style.bold:
                fg = brighten(fg, 1.12)
            draw.rectangle([(x, y), (x + char_w, y + char_h)], fill=bg)
            if not style.hidden:
                draw.text((x, y), symbol, fill=fg, font=font)
            if style.underline:
                uy = y + char_h - 2
                draw.line((x, uy, x + char_w - 1, uy), fill=fg, width=1)
    return image


def tmux(sock: str, *args: str, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    command = ["tmux", "-L", sock, *args]
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        text=True,
    )
    if check and result.returncode != 0:
        stderr = result.stderr or ""
        raise RuntimeError(f"tmux command failed: {' '.join(command)}\n{stderr}")
    return result


def pane_size(sock: str, target: str) -> Tuple[int, int]:
    out = tmux(sock, "display-message", "-p", "-t", target, "#{pane_width} #{pane_height}", capture=True)
    parts = (out.stdout or "").strip().split()
    if len(parts) != 2:
        return (180, 52)
    return (max(40, int(parts[0])), max(15, int(parts[1])))


def capture_ansi(sock: str, target: str, height: int) -> str:
    start = f"-{height}"
    out = tmux(
        sock,
        "capture-pane",
        "-eNpt",
        target,
        "-S",
        start,
        capture=True,
    )
    return out.stdout or ""


def send_key(sock: str, target: str, key: str, sleep_ms: int = 120) -> None:
    tmux(sock, "send-keys", "-t", target, key)
    time.sleep(sleep_ms / 1000.0)


def send_literal(sock: str, target: str, text: str, sleep_ms: int = 120) -> None:
    tmux(sock, "send-keys", "-t", target, "-l", text)
    time.sleep(sleep_ms / 1000.0)


def send_line(sock: str, target: str, text: str) -> None:
    send_literal(sock, target, text)
    send_key(sock, target, "Enter")


def ensure_herd_binary(repo_root: pathlib.Path) -> pathlib.Path:
    binary = repo_root / "target" / "debug" / "herd"
    if binary.exists():
        return binary
    result = subprocess.run(["cargo", "build"], cwd=repo_root)
    if result.returncode != 0 or not binary.exists():
        raise RuntimeError("failed to build herd binary")
    return binary


def main() -> int:
    parser = argparse.ArgumentParser(description="Record herd TUI UX into an animated GIF.")
    parser.add_argument(
        "--output",
        default="docs/screenshots/herd_ux_integration.gif",
        help="Output GIF path.",
    )
    parser.add_argument(
        "--font-size",
        type=int,
        default=15,
        help="Monospace font size.",
    )
    parser.add_argument(
        "--frame-ms",
        type=int,
        default=850,
        help="Per-step frame duration in milliseconds.",
    )
    args = parser.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    output_path = (repo_root / args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    tmp_dir = repo_root / "tmp" / f"ux_gif_{int(time.time())}_{random.randint(1000,9999)}"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    config_path = tmp_dir / "settings.json"
    state_path = tmp_dir / "state.json"

    herd_bin = ensure_herd_binary(repo_root)
    sock = f"herd_ux_{random.randint(10000, 99999)}"
    shell_cmd = "env -u TMOUT bash --noprofile --norc -i"
    target = "herd_ui:ui"
    frames: List[FrameState] = []
    font = load_font(args.font_size)

    try:
        # Seed worker sessions similar to integration tests.
        tmux(sock, "new-session", "-d", "-x", "220", "-y", "60", "-s", "alpha", "-n", "plan", shell_cmd)
        tmux(sock, "new-window", "-t", "alpha", "-n", "build", shell_cmd)
        tmux(sock, "new-session", "-d", "-x", "220", "-y", "60", "-s", "beta", "-n", "review", shell_cmd)
        tmux(sock, "new-session", "-d", "-x", "220", "-y", "60", "-s", "gamma", "-n", "logs", shell_cmd)
        tmux(sock, "set-option", "-s", "exit-empty", "off")
        tmux(sock, "set-option", "-g", "destroy-unattached", "off")

        send_line(sock, "alpha:plan", "echo 'alpha: planning phased refactor'")
        send_line(sock, "beta:review", "echo 'beta: waiting for user confirmation'")
        send_line(sock, "gamma:logs", "echo 'gamma: stalled due to missing context'")

        # Start herd UI as a tmux pane and wait for it to render.
        tmux(
            sock,
            "new-session",
            "-d",
            "-x",
            "220",
            "-y",
            "60",
            "-s",
            "herd_ui",
            "-n",
            "ui",
            "env",
            f"HERD_CONFIG={config_path}",
            f"HERD_STATE={state_path}",
            str(herd_bin),
            "--tmux-socket",
            sock,
            "tui",
        )
        tmux(sock, "set-option", "-t", "herd_ui", "destroy-unattached", "off")

        deadline = time.time() + 12
        ready = False
        while time.time() < deadline:
            snap = capture_ansi(sock, target, 120)
            if "Sessions" in snap and "server (online)" in snap:
                ready = True
                break
            time.sleep(0.2)
        if not ready:
            raise RuntimeError("herd ui did not become ready in time")

        width, height = pane_size(sock, target)

        def capture_step(title: str, duration: int | None = None) -> None:
            ansi = capture_ansi(sock, target, height)
            parsed = parse_ansi_lines(ansi, width, height)
            image = render_terminal_frame(parsed, font, title)
            frames.append(FrameState(image=image, duration_ms=duration or args.frame_ms))

        capture_step("herd ux: sessions overview")

        send_key(sock, target, "j")
        capture_step("herd ux: move selection")

        send_key(sock, target, "1")
        capture_step("herd ux: assign selected session to herd 1")

        send_key(sock, target, ",")
        capture_step("herd ux: settings overlay")

        send_key(sock, target, "j")
        send_key(sock, target, "j")
        capture_step("herd ux: navigate settings")

        send_key(sock, target, "Escape")
        capture_step("herd ux: close settings")

        send_key(sock, target, "l")
        send_key(sock, target, "i")
        send_literal(sock, target, "Please continue and run tests.")
        send_key(sock, target, "Enter")
        send_literal(sock, target, "Report failures first.")
        capture_step("herd ux: content input mode draft")

        # Submit with Shift+Enter CSI-u encoding (same as integration tests).
        send_literal(sock, target, "\u001b[13;2u")
        capture_step("herd ux: submitted input to tmux pane")

        send_key(sock, target, "Escape")
        send_key(sock, target, "H")
        send_key(sock, target, "J")
        send_key(sock, target, "J")
        send_key(sock, target, "J")
        send_key(sock, target, "J")
        send_key(sock, target, "2")
        capture_step("herd ux: herder log filtered to herd 2")

        capture_step("herd ux: complete", duration=1600)

        if not frames:
            raise RuntimeError("no frames captured for herd ux gif")

        base = frames[0].image
        rest = [frame.image for frame in frames[1:]]
        durations = [frame.duration_ms for frame in frames]
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
        return 0
    finally:
        try:
            tmux(sock, "kill-server", check=False)
        except Exception:
            pass
        # Keep artifacts deterministic but leave generated settings/state if needed for debug.
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
