use image::{imageops::FilterType, GrayImage, ImageFormat, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

const DEFAULT_BROWSER_URL: &str = "https://example.com/";
const BROWSER_URL_EVENT: &str = "browser-url-changed";
const BROWSER_DRIVE_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_BROWSER_PAGE_ZOOM: f64 = 1.0;
const MIN_BROWSER_PAGE_ZOOM: f64 = 0.25;
const MAX_BROWSER_PAGE_ZOOM: f64 = 20.0;
const DEFAULT_TEXT_COLUMNS: u32 = 80;
const MIN_TEXT_COLUMNS: u32 = 10;
const MAX_TEXT_COLUMNS: u32 = 200;
const BRAILLE_BLANK: char = '\u{2800}';
const BRAILLE_DOT_MASKS: [u8; 8] = [0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80];
const BAYER_4X4_THRESHOLDS: [u8; 16] = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const ASCII_RAMP: &[u8] = br#" .'`^",:;Il!i~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"#;
const ASCII_TEXT_ASPECT_RATIO: f64 = 0.5;
const TEXT_GRID_MIN_ROW_HEIGHT_RATIO: f64 = 0.9;
const TEXT_GRID_MAX_ROW_HEIGHT_RATIO: f64 = 2.2;
const TEXT_GRID_FALLBACK_ROW_HEIGHT_RATIO: f64 = 1.4;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
    pub page_zoom: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewState {
    pub current_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtensionPage {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BrowserExtensionCallerContext {
    pub sender_tile_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_agent_role: Option<crate::agent::AgentRole>,
    pub target_tile_id: String,
    pub target_pane_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserUrlChangedEvent {
    pane_id: String,
    url: String,
    loading: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserImageScreenshotResult {
    mime_type: String,
    data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTextScreenshotResult {
    format: String,
    text: String,
    columns: u32,
    rows: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTextLayoutFragment {
    text: String,
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserTextLayoutSnapshot {
    viewport_width: f64,
    viewport_height: f64,
    fragments: Vec<BrowserTextLayoutFragment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum BrowserScreenshotResult {
    Image(BrowserImageScreenshotResult),
    Text(BrowserTextScreenshotResult),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserScreenshotFormat {
    Image,
    Braille,
    Ascii,
    Ansi,
    Text,
}

#[derive(Debug, Clone, Copy)]
struct BrowserScreenshotOptions {
    format: BrowserScreenshotFormat,
    columns: u32,
}

impl BrowserScreenshotFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Braille => "braille",
            Self::Ascii => "ascii",
            Self::Ansi => "ansi",
            Self::Text => "text",
        }
    }

    fn uses_text_columns(self) -> bool {
        !matches!(self, Self::Image)
    }
}

fn browser_webview_label(pane_id: &str) -> String {
    let mut label = String::from("browser-pane-");
    for byte in pane_id.as_bytes() {
        label.push_str(&format!("{byte:02x}"));
    }
    label
}

fn hidden_browser_viewport() -> BrowserViewport {
    BrowserViewport {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
        visible: false,
        page_zoom: DEFAULT_BROWSER_PAGE_ZOOM,
    }
}

fn sanitize_browser_page_zoom(page_zoom: f64) -> f64 {
    if !page_zoom.is_finite() || page_zoom <= 0.0 {
        return DEFAULT_BROWSER_PAGE_ZOOM;
    }

    page_zoom.clamp(MIN_BROWSER_PAGE_ZOOM, MAX_BROWSER_PAGE_ZOOM)
}

fn apply_browser_page_zoom(webview: &tauri::Webview, page_zoom: f64) -> Result<(), String> {
    webview
        .set_zoom(sanitize_browser_page_zoom(page_zoom))
        .map_err(|error| format!("failed to apply browser page zoom: {error}"))
}

fn parse_browser_url(raw: Option<&str>) -> Result<Url, String> {
    let value = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BROWSER_URL);
    let parsed = Url::parse(value).map_err(|error| format!("invalid browser URL {value}: {error}"))?;
    match parsed.scheme() {
        "http" | "https" | "about" | "file" => Ok(parsed),
        scheme => Err(format!("unsupported browser URL scheme: {scheme}")),
    }
}

fn resolve_browser_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("browser load path cannot be empty".to_string());
    }

    let requested = PathBuf::from(trimmed);
    let absolute = if requested.is_absolute() {
        requested
    } else {
        crate::runtime::project_root_dir().join(requested)
    };
    let canonical = std::fs::canonicalize(&absolute)
        .map_err(|error| format!("failed to resolve browser path {}: {error}", absolute.display()))?;
    if !canonical.is_file() {
        return Err(format!("browser load path is not a file: {}", canonical.display()));
    }
    Ok(canonical)
}

fn resolve_browser_file_url(path: &str) -> Result<Url, String> {
    let canonical = resolve_browser_file_path(path)?;
    Url::from_file_path(&canonical)
        .map_err(|_| format!("failed to convert browser path to file URL: {}", canonical.display()))
}

fn collect_browser_extension_html_files(dir: &std::path::Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries = fs::read_dir(dir)
        .map_err(|error| format!("failed to read browser extensions directory {}: {error}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read browser extensions directory {}: {error}", dir.display()))?;
    entries.sort_by_key(|entry| entry.path());

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_browser_extension_html_files(&path, files)?;
            continue;
        }
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("html"))
            .unwrap_or(false)
        {
            files.push(path);
        }
    }

    Ok(())
}

fn browser_extension_page_label(relative_path: &std::path::Path) -> String {
    let mut parts: Vec<String> = relative_path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(|component| component.to_string())
        .collect();

    if parts.last().map(|part| part.eq_ignore_ascii_case("index.html")).unwrap_or(false) {
        parts.pop();
    } else if let Some(last) = parts.last_mut() {
        if let Some(stem) = std::path::Path::new(last)
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string())
        {
            *last = stem;
        }
    }

    if parts.is_empty() {
        return "Browser Page".to_string();
    }

    parts
        .into_iter()
        .map(|part| {
            part
                .split(['-', '_', ' '])
                .filter(|segment| !segment.is_empty())
                .map(|segment| {
                    let mut chars = segment.chars();
                    match chars.next() {
                        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" / ")
}

#[tauri::command]
pub async fn browser_extension_pages() -> Result<Vec<BrowserExtensionPage>, String> {
    let project_root = crate::runtime::project_root_dir();
    let base_dir = project_root.join("extensions").join("browser");
    if !base_dir.exists() {
        return Ok(Vec::new());
    }

    let mut html_files = Vec::new();
    collect_browser_extension_html_files(&base_dir, &mut html_files)?;
    html_files.sort();

    html_files
        .into_iter()
        .map(|path| {
            let relative_to_base = path
                .strip_prefix(&base_dir)
                .map_err(|error| format!("failed to compute browser extension path {}: {error}", path.display()))?;
            let relative_to_project = path
                .strip_prefix(&project_root)
                .map_err(|error| format!("failed to compute browser extension project path {}: {error}", path.display()))?;
            Ok(BrowserExtensionPage {
                label: browser_extension_page_label(relative_to_base),
                path: relative_to_project.to_string_lossy().replace('\\', "/"),
            })
        })
        .collect()
}

fn browser_current_url(webview: &tauri::Webview) -> Result<String, String> {
    webview
        .url()
        .map(|url| url.to_string())
        .map_err(|error| format!("failed to read browser URL: {error}"))
}

pub fn current_url_for_pane(app: &tauri::AppHandle, pane_id: &str) -> Option<String> {
    let webview = get_browser_webview(app, pane_id)?;
    browser_current_url(&webview).ok()
}

fn emit_browser_url_changed(
    app: &tauri::AppHandle,
    pane_id: &str,
    url: String,
    loading: bool,
) {
    let _ = app.emit(
        BROWSER_URL_EVENT,
        BrowserUrlChangedEvent {
            pane_id: pane_id.to_string(),
            url,
            loading,
        },
    );
}

fn browser_tile_incognito(app: &tauri::AppHandle, pane_id: &str) -> bool {
    let state = app.state::<crate::state::AppState>();
    state
        .tile_record_by_pane(pane_id)
        .ok()
        .flatten()
        .map(|record| record.browser_incognito)
        .unwrap_or(false)
}

fn apply_browser_viewport(
    app: &tauri::AppHandle,
    pane_id: &str,
    webview: &tauri::Webview,
    viewport: &BrowserViewport,
) -> Result<(), String> {
    let page_zoom = sanitize_browser_page_zoom(viewport.page_zoom);
    let state = app.state::<crate::state::AppState>();
    state.set_browser_page_zoom(pane_id, page_zoom);
    if viewport.visible && viewport.width > 1.0 && viewport.height > 1.0 {
        webview
            .set_position(LogicalPosition::new(viewport.x, viewport.y))
            .map_err(|error| format!("failed to position browser webview: {error}"))?;
        webview
            .set_size(LogicalSize::new(viewport.width, viewport.height))
            .map_err(|error| format!("failed to resize browser webview: {error}"))?;
        webview
            .show()
            .map_err(|error| format!("failed to show browser webview: {error}"))?;
    } else {
        webview
            .hide()
            .map_err(|error| format!("failed to hide browser webview: {error}"))?;
    }

    apply_browser_page_zoom(webview, page_zoom)?;
    Ok(())
}

fn get_browser_webview(app: &tauri::AppHandle, pane_id: &str) -> Option<tauri::Webview> {
    app.get_webview(&browser_webview_label(pane_id))
}

fn required_browser_drive_string_arg(args: &Value, field: &str, action: &str) -> Result<String, String> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("browser_drive {action} requires a non-empty string field `{field}`"))
}

fn browser_drive_action_script(action: &str, args: &Value) -> Result<String, String> {
    match action {
        "click" => {
            let selector = serde_json::to_string(&required_browser_drive_string_arg(args, "selector", action)?)
                .map_err(|error| format!("failed to serialize browser selector: {error}"))?;
            Ok(format!(
                r#"
const element = document.querySelector({selector});
if (!(element instanceof Element)) {{
  throw new Error(`No element matched selector: ${{{selector}}}`);
}}
element.scrollIntoView({{ block: 'center', inline: 'center' }});
if (typeof element.click === 'function') {{
  element.click();
}} else {{
  element.dispatchEvent(new MouseEvent('click', {{ bubbles: true, cancelable: true, composed: true }}));
}}
return {{ clicked: true }};
"#
            ))
        }
        "select" => {
            let selector = serde_json::to_string(&required_browser_drive_string_arg(args, "selector", action)?)
                .map_err(|error| format!("failed to serialize browser selector: {error}"))?;
            let value = serde_json::to_string(&required_browser_drive_string_arg(args, "value", action)?)
                .map_err(|error| format!("failed to serialize browser select value: {error}"))?;
            Ok(format!(
                r#"
const element = document.querySelector({selector});
if (!(element instanceof Element)) {{
  throw new Error(`No element matched selector: ${{{selector}}}`);
}}
element.scrollIntoView({{ block: 'center', inline: 'center' }});
if (!(element instanceof HTMLSelectElement)) {{
  throw new Error(`Element matched by ${{{selector}}} is not a select element`);
}}
const value = {value};
const option = Array.from(element.options).find((entry) => entry.value === value);
if (!option) {{
  throw new Error(`No option matched value ${{value}} for selector ${{{selector}}}`);
}}
element.value = value;
option.selected = true;
element.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
element.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
return {{ value: element.value }};
"#
            ))
        }
        "type" => {
            let selector = serde_json::to_string(&required_browser_drive_string_arg(args, "selector", action)?)
                .map_err(|error| format!("failed to serialize browser selector: {error}"))?;
            let text = serde_json::to_string(&required_browser_drive_string_arg(args, "text", action)?)
                .map_err(|error| format!("failed to serialize browser input text: {error}"))?;
            let clear = args.get("clear").and_then(Value::as_bool).unwrap_or(true);
            Ok(format!(
                r#"
const element = document.querySelector({selector});
if (!(element instanceof Element)) {{
  throw new Error(`No element matched selector: ${{{selector}}}`);
}}
element.scrollIntoView({{ block: 'center', inline: 'center' }});
if (typeof element.focus === 'function') {{
  element.focus();
}}
const text = {text};
const clear = {clear};
if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {{
  const nextValue = clear ? text : `${{element.value}}${{text}}`;
  element.value = nextValue;
  element.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
  element.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
  return {{ value: element.value }};
}}
if (element instanceof HTMLElement && element.isContentEditable) {{
  const nextValue = clear ? text : `${{element.textContent ?? ''}}${{text}}`;
  element.textContent = nextValue;
  element.dispatchEvent(new Event('input', {{ bubbles: true, cancelable: true }}));
  element.dispatchEvent(new Event('change', {{ bubbles: true, cancelable: true }}));
  return {{ value: element.textContent ?? '' }};
}}
throw new Error(`Element matched by ${{{selector}}} is not a supported text input`);
"#
            ))
        }
        "dom_query" => {
            let js = required_browser_drive_string_arg(args, "js", action)?;
            Ok(format!("return (\n{js}\n);"))
        }
        "eval" => required_browser_drive_string_arg(args, "js", action),
        other => Err(format!("unsupported browser_drive action: {other}")),
    }
}

fn browser_drive_wrapper_script(action_script: &str, args: &Value) -> Result<String, String> {
    let args_json = serde_json::to_string(args)
        .map_err(|error| format!("failed to serialize browser drive args: {error}"))?;
    Ok(format!(
        r#"(function() {{
const __herdArgs = {args_json};
const __herdResult = (() => {{
  try {{
    const __result = (function(args) {{
{action_script}
    }})(__herdArgs);
    return JSON.stringify({{
      ok: true,
      data: __result === undefined ? null : __result,
    }});
  }} catch (error) {{
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    return JSON.stringify({{
      ok: false,
      error: message,
    }});
  }}
}})();
return __herdResult;
}})();"#,
    ))
}

fn browser_text_snapshot_script() -> &'static str {
    r#"
const root = document.body ?? document.documentElement;
const baseViewportWidth = Math.max(
  window.innerWidth || 0,
  document.documentElement?.clientWidth || 0,
  document.documentElement?.scrollWidth || 0,
  document.body?.scrollWidth || 0,
  document.body?.offsetWidth || 0,
  1,
);
const baseViewportHeight = Math.max(
  window.innerHeight || 0,
  document.documentElement?.clientHeight || 0,
  document.documentElement?.scrollHeight || 0,
  document.body?.scrollHeight || 0,
  document.body?.offsetHeight || 0,
  1,
);

const isFiniteRect = (rect) =>
  Number.isFinite(rect.left)
  && Number.isFinite(rect.top)
  && Number.isFinite(rect.width)
  && Number.isFinite(rect.height);

const normalizeRect = (rect) => {
  if (!(rect.width > 0.5 && rect.height > 0.5)) {
    return null;
  }
  const normalized = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  return isFiniteRect(normalized) ? normalized : null;
};

const mergeLineRects = (rectList) => {
  const merged = [];
  for (const rect of rectList) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && Math.abs(previous.top - rect.top) <= 2
      && Math.abs(previous.height - rect.height) <= 8
    ) {
      const right = Math.max(previous.left + previous.width, rect.left + rect.width);
      previous.left = Math.min(previous.left, rect.left);
      previous.top = Math.min(previous.top, rect.top);
      previous.width = right - previous.left;
      previous.height = Math.max(previous.height, rect.height);
      continue;
    }
    merged.push({ ...rect });
  }
  return merged;
};

const visibleRangeRects = (range) =>
  mergeLineRects(
    Array.from(range.getClientRects())
      .map((rect) => normalizeRect(rect))
      .filter((rect) => rect !== null)
      .sort((a, b) => a.top - b.top || a.left - b.left),
  );

const isVisibleElement = (element) => {
  if (!(element instanceof Element)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none'
    || style.visibility === 'hidden'
    || style.visibility === 'collapse'
    || Number.parseFloat(style.opacity || '1') === 0
  ) {
    return false;
  }
  const rect = normalizeRect(element.getBoundingClientRect());
  return rect !== null;
};

const preservesWhitespace = (whiteSpace) =>
  whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'break-spaces';

const normalizeRenderedText = (text, whiteSpace) => {
  const normalized = text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  if (preservesWhitespace(whiteSpace)) {
    return normalized;
  }
  return normalized.replace(/\s+/g, ' ').trim();
};

const lineCountForSlice = (node, start, end) => {
  if (end <= start) {
    return 0;
  }
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return visibleRangeRects(range).length;
};

const textFragmentsForNode = (node) => {
  const parent = node.parentElement;
  if (!parent || !isVisibleElement(parent)) {
    return [];
  }
  const rawText = node.textContent ?? '';
  if (!rawText.trim()) {
    return [];
  }
  const fullRange = document.createRange();
  fullRange.selectNodeContents(node);
  const lineRects = visibleRangeRects(fullRange);
  if (!lineRects.length) {
    return [];
  }
  const whiteSpace = window.getComputedStyle(parent).whiteSpace || 'normal';
  const preserve = preservesWhitespace(whiteSpace);
  const fragments = [];
  let start = 0;
  if (!preserve) {
    while (start < rawText.length && /\s/.test(rawText[start])) {
      start += 1;
    }
  }
  for (let index = 0; index < lineRects.length && start < rawText.length; index += 1) {
    const rect = lineRects[index];
    let end = rawText.length;
    if (index < lineRects.length - 1) {
      let low = start + 1;
      let high = rawText.length;
      let best = low;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const lineCount = lineCountForSlice(node, start, mid);
        if (lineCount <= 1) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      end = Math.max(start + 1, best);
    }
    const text = normalizeRenderedText(rawText.slice(start, end), whiteSpace);
    if (text) {
      fragments.push({ text, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    start = end;
    if (!preserve) {
      while (start < rawText.length && /\s/.test(rawText[start])) {
        start += 1;
      }
    }
  }
  return fragments;
};

const controlText = (element) => {
  if (element instanceof HTMLInputElement) {
    if (element.type === 'hidden' || element.type === 'password') {
      return null;
    }
    return normalizeRenderedText(
      element.value || element.placeholder || element.getAttribute('aria-label') || '',
      'normal',
    );
  }
  if (element instanceof HTMLTextAreaElement) {
    return normalizeRenderedText(
      element.value || element.placeholder || element.getAttribute('aria-label') || '',
      'pre-wrap',
    );
  }
  if (element instanceof HTMLSelectElement) {
    const selected = Array.from(element.selectedOptions)
      .map((option) => option.textContent ?? '')
      .join(' ');
    return normalizeRenderedText(selected || element.getAttribute('aria-label') || '', 'normal');
  }
  if (element instanceof HTMLImageElement) {
    return normalizeRenderedText(element.alt || '', 'normal');
  }
  const ariaLabel = element.getAttribute('aria-label') || '';
  if (ariaLabel && !(element instanceof HTMLElement && element.innerText.trim())) {
    return normalizeRenderedText(ariaLabel, 'normal');
  }
  return null;
};

const fragments = [];
if (root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let currentNode = walker.nextNode();
  while (currentNode) {
    fragments.push(...textFragmentsForNode(currentNode));
    currentNode = walker.nextNode();
  }
}

for (const element of document.querySelectorAll('input, textarea, select, img[alt], [aria-label]')) {
  if (!isVisibleElement(element)) {
    continue;
  }
  const text = controlText(element);
  if (!text) {
    continue;
  }
  const rect = normalizeRect(element.getBoundingClientRect());
  if (!rect) {
    continue;
  }
  fragments.push({ text, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
}

let offsetLeft = 0;
let offsetTop = 0;
for (const fragment of fragments) {
  offsetLeft = Math.min(offsetLeft, fragment.left);
  offsetTop = Math.min(offsetTop, fragment.top);
}
if (offsetLeft < 0 || offsetTop < 0) {
  for (const fragment of fragments) {
    fragment.left -= offsetLeft;
    fragment.top -= offsetTop;
  }
}

fragments.sort((a, b) => a.top - b.top || a.left - b.left);
const viewportWidth = Math.max(
  baseViewportWidth,
  ...fragments.map((fragment) => fragment.left + fragment.width),
  1,
);
const viewportHeight = Math.max(
  baseViewportHeight,
  ...fragments.map((fragment) => fragment.top + fragment.height),
  1,
);
return {
  viewportWidth,
  viewportHeight,
  fragments,
};
"#
}

#[derive(Debug, Deserialize)]
struct BrowserDriveEnvelope {
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowserExtensionEnvelope {
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum BrowserExtensionScreenshotSource {
    PngBase64 {
        #[serde(default)]
        mime_type: Option<String>,
        data_base64: String,
    },
}

fn browser_screenshot_options(args: &Value) -> Result<BrowserScreenshotOptions, String> {
    let format = parse_browser_screenshot_format(
        args.get("format").and_then(Value::as_str),
        "browser_drive screenshot",
        true,
    )?;

    let columns = if format.uses_text_columns() {
        parse_text_columns_arg(args.get("columns"), "browser_drive screenshot")?
    } else {
        DEFAULT_TEXT_COLUMNS
    };

    Ok(BrowserScreenshotOptions { format, columns })
}

fn browser_extension_screenshot_options(args: &Value) -> Result<BrowserScreenshotOptions, String> {
    let format = parse_browser_screenshot_format(
        args.get("format").and_then(Value::as_str),
        "browser extension screenshot",
        true,
    )?;

    let columns = if format.uses_text_columns() {
        parse_text_columns_arg(args.get("columns"), "browser extension screenshot")?
    } else {
        DEFAULT_TEXT_COLUMNS
    };

    Ok(BrowserScreenshotOptions { format, columns })
}

fn browser_extension_screenshot_png_bytes(value: Value) -> Result<Vec<u8>, String> {
    let source: BrowserExtensionScreenshotSource = serde_json::from_value(value)
        .map_err(|error| format!("browser extension screenshot returned invalid source JSON: {error}"))?;
    match source {
        BrowserExtensionScreenshotSource::PngBase64 {
            mime_type,
            data_base64,
        } => {
            if mime_type
                .as_deref()
                .map(|value| value != "image/png")
                .unwrap_or(false)
            {
                return Err("browser extension screenshot requires mime_type `image/png`".to_string());
            }
            use base64::engine::general_purpose::STANDARD;
            use base64::Engine as _;

            let png_bytes = STANDARD
                .decode(data_base64)
                .map_err(|error| format!("browser extension screenshot returned invalid base64 PNG data: {error}"))?;
            if png_bytes.is_empty() {
                return Err("browser extension screenshot returned empty PNG data".to_string());
            }
            Ok(png_bytes)
        }
    }
}

fn browser_extension_screenshot_result_from_value(
    value: Value,
    args: &Value,
) -> Result<BrowserScreenshotResult, String> {
    let options = browser_extension_screenshot_options(args)?;
    let png_bytes = browser_extension_screenshot_png_bytes(value)?;
    match options.format {
        BrowserScreenshotFormat::Image => Ok(image_screenshot_result(&png_bytes)),
        BrowserScreenshotFormat::Braille
        | BrowserScreenshotFormat::Ascii
        | BrowserScreenshotFormat::Ansi
        | BrowserScreenshotFormat::Text => {
            text_screenshot_result_from_png(&png_bytes, options.format, options.columns)
        }
    }
}

fn browser_extension_source_path(current_url: &str) -> Option<String> {
    let parsed = Url::parse(current_url).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    let file_path = parsed.to_file_path().ok()?;
    let project_root = crate::runtime::project_root_dir();
    let relative = file_path.strip_prefix(&project_root).ok()?;
    let normalized = relative.to_string_lossy().replace('\\', "/");
    if normalized.starts_with("extensions/browser/") {
        Some(normalized)
    } else {
        None
    }
}

fn browser_extension_manifest_script() -> &'static str {
    r#"(function() {
const envelope = (() => {
  try {
    const extension = globalThis.HerdBrowserExtension;
    if (!extension || typeof extension !== 'object') {
      return { ok: true, data: null };
    }
    const manifest = extension.manifest;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('HerdBrowserExtension.manifest must be an object');
    }
    return { ok: true, data: manifest };
  } catch (error) {
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    return { ok: false, error: message };
  }
})();
return JSON.stringify(envelope);
})();"#
}

fn browser_extension_call_script(
    method: &str,
    args: &Value,
    caller: &BrowserExtensionCallerContext,
) -> Result<String, String> {
    let method_json = serde_json::to_string(method)
        .map_err(|error| format!("failed to serialize browser extension method: {error}"))?;
    let args_json = serde_json::to_string(args)
        .map_err(|error| format!("failed to serialize browser extension args: {error}"))?;
    let caller_json = serde_json::to_string(caller)
        .map_err(|error| format!("failed to serialize browser extension caller: {error}"))?;
    Ok(format!(
        r#"(function() {{
const method = {method_json};
const args = {args_json};
const caller = {caller_json};
const envelope = (() => {{
  try {{
    const extension = globalThis.HerdBrowserExtension;
    if (!extension || typeof extension.call !== 'function') {{
      throw new Error('browser page does not expose HerdBrowserExtension.call');
    }}
    const result = extension.call(method, args, caller);
    if (result && typeof result === 'object' && typeof result.then === 'function') {{
      throw new Error('browser extension methods must return synchronously');
    }}
    return {{
      ok: true,
      data: result === undefined ? null : result,
    }};
  }} catch (error) {{
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    return {{
      ok: false,
      error: message,
    }};
  }}
}})();
return JSON.stringify(envelope);
}})();"#,
    ))
}

fn sanitize_browser_extension_info(
    value: Value,
    source_path: String,
) -> Result<crate::network::BrowserExtensionInfo, String> {
    let mut info: crate::network::BrowserExtensionInfo = serde_json::from_value(value)
        .map_err(|error| format!("browser extension manifest is invalid: {error}"))?;
    if info.extension_id.trim().is_empty() {
        return Err("browser extension manifest requires a non-empty extension_id".to_string());
    }
    if info.label.trim().is_empty() {
        return Err("browser extension manifest requires a non-empty label".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for method in &info.methods {
        if method.name.trim().is_empty() {
            return Err("browser extension manifest methods require non-empty names".to_string());
        }
        if !seen.insert(method.name.clone()) {
            return Err(format!("browser extension manifest method names must be unique: {}", method.name));
        }
    }
    info.source_path = Some(source_path);
    Ok(info)
}

pub fn browser_extension_info_for_pane(
    app: &tauri::AppHandle,
    pane_id: &str,
) -> Option<crate::network::BrowserExtensionInfo> {
    let webview = get_browser_webview(app, pane_id)?;
    let current_url = browser_current_url(&webview).ok()?;
    let source_path = browser_extension_source_path(&current_url)?;
    let raw_result = evaluate_browser_script(&webview, browser_extension_manifest_script()).ok()?;
    let envelope: BrowserExtensionEnvelope = serde_json::from_str(&raw_result).ok()?;
    if !envelope.ok {
        return None;
    }
    let data = envelope.data?;
    sanitize_browser_extension_info(data, source_path).ok()
}

fn parse_browser_screenshot_format(
    raw: Option<&str>,
    context: &str,
    allow_image: bool,
) -> Result<BrowserScreenshotFormat, String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None if allow_image => Ok(BrowserScreenshotFormat::Image),
        None => Ok(BrowserScreenshotFormat::Text),
        Some("image") if allow_image => Ok(BrowserScreenshotFormat::Image),
        Some("braille") => Ok(BrowserScreenshotFormat::Braille),
        Some("ascii") => Ok(BrowserScreenshotFormat::Ascii),
        Some("ansi") => Ok(BrowserScreenshotFormat::Ansi),
        Some("text") => Ok(BrowserScreenshotFormat::Text),
        Some(other) if allow_image => Err(format!(
            "{context} requires `format` to be one of `image`, `braille`, `ascii`, `ansi`, or `text`, got `{other}`"
        )),
        Some(other) => Err(format!(
            "{context} requires `format` to be one of `text`, `braille`, `ansi`, or `ascii`, got `{other}`"
        )),
    }
}

fn browser_preview_options(
    format: Option<&str>,
    columns: Option<&Value>,
) -> Result<BrowserScreenshotOptions, String> {
    Ok(BrowserScreenshotOptions {
        format: parse_browser_screenshot_format(format, "browser preview", false)?,
        columns: parse_text_columns_arg(columns, "browser preview")?,
    })
}

fn parse_text_columns_arg(value: Option<&Value>, context: &str) -> Result<u32, String> {
    match value {
        None => Ok(DEFAULT_TEXT_COLUMNS),
        Some(value) => {
            let parsed = value
                .as_u64()
                .ok_or_else(|| format!("{context} requires `columns` to be a positive integer"))?
                as u32;
            if !(MIN_TEXT_COLUMNS..=MAX_TEXT_COLUMNS).contains(&parsed) {
                return Err(format!(
                    "{context} requires `columns` to be between {MIN_TEXT_COLUMNS} and {MAX_TEXT_COLUMNS}"
                ));
            }
            Ok(parsed)
        }
    }
}

fn grayscale_invert(image: &GrayImage) -> bool {
    let pixel_count = (image.width() * image.height()) as f32;
    let average_luma = image.pixels().map(|pixel| pixel.0[0] as u64).sum::<u64>() as f32 / pixel_count;
    average_luma < 110.0
}

fn normalized_darkness(luma: u8, invert: bool) -> f32 {
    if invert {
        luma as f32 / 255.0
    } else {
        1.0 - (luma as f32 / 255.0)
    }
}

fn ordered_dither_threshold(x: u32, y: u32) -> f32 {
    let index = ((y % 4) * 4 + (x % 4)) as usize;
    (BAYER_4X4_THRESHOLDS[index] as f32 + 0.5) / 16.0
}

fn ordered_dither_active(luma: u8, x: u32, y: u32, invert: bool) -> bool {
    normalized_darkness(luma, invert) >= ordered_dither_threshold(x, y)
}

fn resize_for_braille(image: &GrayImage, columns: u32) -> GrayImage {
    let target_width = columns.max(1).saturating_mul(2);
    let scaled_height =
        ((image.height() as f64 * target_width as f64) / image.width().max(1) as f64).round() as u32;
    let target_height = scaled_height.max(4);
    let padded_height = ((target_height + 3) / 4) * 4;
    image::imageops::resize(image, target_width, padded_height, FilterType::Triangle)
}

fn resize_for_ascii(image: &GrayImage, columns: u32) -> GrayImage {
    let target_width = columns.max(1);
    let scaled_height = ((image.height() as f64 * target_width as f64 * ASCII_TEXT_ASPECT_RATIO)
        / image.width().max(1) as f64)
        .round() as u32;
    let target_height = scaled_height.max(1);
    image::imageops::resize(image, target_width, target_height, FilterType::Triangle)
}

fn resize_for_ansi(image: &RgbImage, columns: u32) -> RgbImage {
    let target_width = columns.max(1);
    let scaled_height =
        ((image.height() as f64 * target_width as f64) / image.width().max(1) as f64).round() as u32;
    let target_height = scaled_height.max(2);
    let padded_height = if target_height % 2 == 0 {
        target_height
    } else {
        target_height + 1
    };
    image::imageops::resize(image, target_width, padded_height, FilterType::Triangle)
}

fn braille_text_from_gray_image(image: &GrayImage, columns: u32) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("browser screenshot image was empty".to_string());
    }

    let resized = resize_for_braille(image, columns);
    let invert = grayscale_invert(&resized);

    let mut lines = Vec::new();
    for cell_y in (0..resized.height()).step_by(4) {
        let mut line = String::with_capacity((resized.width() / 2) as usize);
        for cell_x in (0..resized.width()).step_by(2) {
            let mut pattern = 0u8;
            for dy in 0..4 {
                for dx in 0..2 {
                    let pixel_x = cell_x + dx;
                    let pixel_y = cell_y + dy;
                    let luma = resized.get_pixel(pixel_x, pixel_y).0[0];
                    if ordered_dither_active(luma, pixel_x, pixel_y, invert) {
                        pattern |= BRAILLE_DOT_MASKS[(dy * 2 + dx) as usize];
                    }
                }
            }
            line.push(char::from_u32(0x2800 + pattern as u32).unwrap_or(BRAILLE_BLANK));
        }
        lines.push(line);
    }

    if lines.is_empty() {
        return Ok(BRAILLE_BLANK.to_string());
    }
    Ok(lines.join("\n"))
}

fn ascii_char_for_luma(luma: u8, invert: bool) -> char {
    let darkness = normalized_darkness(luma, invert);
    let max_index = ASCII_RAMP.len().saturating_sub(1) as f32;
    let index = (darkness * max_index).round() as usize;
    ASCII_RAMP[index.min(ASCII_RAMP.len().saturating_sub(1))] as char
}

fn ascii_text_from_gray_image(image: &GrayImage, columns: u32) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("browser screenshot image was empty".to_string());
    }

    let resized = resize_for_ascii(image, columns);
    let invert = grayscale_invert(&resized);
    let mut lines = Vec::new();
    for y in 0..resized.height() {
        let mut line = String::with_capacity(resized.width() as usize);
        for x in 0..resized.width() {
            let luma = resized.get_pixel(x, y).0[0];
            line.push(ascii_char_for_luma(luma, invert));
        }
        lines.push(line);
    }

    if lines.is_empty() {
        return Ok(" ".to_string());
    }
    Ok(lines.join("\n"))
}

fn ansi_text_from_rgb_image(image: &RgbImage, columns: u32) -> Result<String, String> {
    if image.width() == 0 || image.height() == 0 {
        return Err("browser screenshot image was empty".to_string());
    }

    let resized = resize_for_ansi(image, columns);
    let mut lines = Vec::new();
    for y in (0..resized.height()).step_by(2) {
        let mut line = String::new();
        for x in 0..resized.width() {
            let top = resized.get_pixel(x, y).0;
            let bottom = resized.get_pixel(x, y + 1).0;
            line.push_str(&format!(
                "\u{1b}[38;2;{};{};{}m\u{1b}[48;2;{};{};{}m▀",
                top[0], top[1], top[2], bottom[0], bottom[1], bottom[2]
            ));
        }
        line.push_str("\u{1b}[0m");
        lines.push(line);
    }

    if lines.is_empty() {
        return Ok("\u{1b}[0m".to_string());
    }
    Ok(lines.join("\n"))
}

fn median_fragment_height(fragments: &[BrowserTextLayoutFragment]) -> Option<f64> {
    let mut heights = fragments
        .iter()
        .map(|fragment| fragment.height)
        .filter(|height| height.is_finite() && *height > 0.5)
        .collect::<Vec<_>>();
    if heights.is_empty() {
        return None;
    }
    heights.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    Some(heights[heights.len() / 2])
}

fn text_grid_row_height(snapshot: &BrowserTextLayoutSnapshot, columns: u32) -> f64 {
    let char_width = (snapshot.viewport_width / columns.max(1) as f64).max(1.0);
    let min_row_height = char_width * TEXT_GRID_MIN_ROW_HEIGHT_RATIO;
    let max_row_height = char_width * TEXT_GRID_MAX_ROW_HEIGHT_RATIO;
    median_fragment_height(&snapshot.fragments)
        .unwrap_or(char_width * TEXT_GRID_FALLBACK_ROW_HEIGHT_RATIO)
        .clamp(min_row_height, max_row_height)
}

fn overlay_text_fragment(grid: &mut [Vec<char>], start_row: usize, start_col: usize, text: &str) {
    if grid.is_empty() || text.is_empty() {
        return;
    }

    let max_rows = grid.len();
    let max_cols = grid[0].len();
    let mut row = start_row;
    let mut col = start_col;
    for ch in text.chars() {
        match ch {
            '\n' => {
                row += 1;
                col = start_col;
                if row >= max_rows {
                    break;
                }
            }
            '\t' => {
                for _ in 0..4 {
                    if row >= max_rows || col >= max_cols {
                        break;
                    }
                    col += 1;
                }
            }
            _ => {
                if row >= max_rows {
                    break;
                }
                if col >= max_cols {
                    col += 1;
                    continue;
                }
                if !ch.is_control() && ch != ' ' {
                    grid[row][col] = ch;
                }
                col += 1;
            }
        }
    }
}

fn text_screenshot_result_from_dom_snapshot(
    snapshot: BrowserTextLayoutSnapshot,
    columns: u32,
) -> Result<BrowserScreenshotResult, String> {
    if !snapshot.viewport_width.is_finite()
        || !snapshot.viewport_height.is_finite()
        || snapshot.viewport_width <= 0.0
        || snapshot.viewport_height <= 0.0
    {
        return Err("browser text snapshot reported an invalid viewport".to_string());
    }

    let row_height = text_grid_row_height(&snapshot, columns);
    let rows = ((snapshot.viewport_height / row_height).ceil() as usize).max(1);
    let columns_usize = columns.max(1) as usize;
    let char_width = (snapshot.viewport_width / columns.max(1) as f64).max(1.0);
    let mut grid = vec![vec![' '; columns_usize]; rows];
    let mut fragments = snapshot
        .fragments
        .into_iter()
        .filter(|fragment| {
            fragment.left.is_finite()
                && fragment.top.is_finite()
                && fragment.width.is_finite()
                && fragment.height.is_finite()
                && fragment.width > 0.0
                && fragment.height > 0.0
                && !fragment.text.is_empty()
        })
        .collect::<Vec<_>>();
    fragments.sort_by(|left, right| {
        left.top
            .partial_cmp(&right.top)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.left.partial_cmp(&right.left).unwrap_or(std::cmp::Ordering::Equal))
    });

    for fragment in fragments {
        let row = ((fragment.top / row_height).round() as isize).clamp(0, rows as isize - 1) as usize;
        let col = ((fragment.left / char_width).round() as isize).clamp(0, columns_usize as isize - 1) as usize;
        overlay_text_fragment(&mut grid, row, col, &fragment.text);
    }

    let text = grid
        .into_iter()
        .map(|line| line.into_iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(text_screenshot_result(BrowserScreenshotFormat::Text, text, columns))
}

fn text_screenshot_result(format: BrowserScreenshotFormat, text: String, columns: u32) -> BrowserScreenshotResult {
    BrowserScreenshotResult::Text(BrowserTextScreenshotResult {
        format: format.as_str().to_string(),
        rows: text.lines().count() as u32,
        text,
        columns,
    })
}

fn browser_preview_result(
    app: &tauri::AppHandle,
    pane_id: &str,
    format: BrowserScreenshotFormat,
    columns: u32,
) -> Result<BrowserTextScreenshotResult, String> {
    let webview = get_browser_webview(app, pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    let BrowserScreenshotResult::Text(payload) = (match format {
        BrowserScreenshotFormat::Text => {
            let snapshot = capture_browser_text_snapshot(&webview)?;
            text_screenshot_result_from_dom_snapshot(snapshot, columns)?
        }
        BrowserScreenshotFormat::Braille
        | BrowserScreenshotFormat::Ascii
        | BrowserScreenshotFormat::Ansi => {
            let png_bytes = capture_browser_screenshot_png(&webview)?;
            text_screenshot_result_from_png(&png_bytes, format, columns)?
        }
        BrowserScreenshotFormat::Image => unreachable!("browser preview should only request text formats"),
    }) else {
        unreachable!("browser preview should always return a text screenshot payload");
    };
    Ok(payload)
}

fn text_screenshot_result_from_png(
    png_bytes: &[u8],
    format: BrowserScreenshotFormat,
    columns: u32,
) -> Result<BrowserScreenshotResult, String> {
    let image = image::load_from_memory_with_format(png_bytes, ImageFormat::Png)
        .map_err(|error| format!("failed to decode browser screenshot PNG: {error}"))?;
    let text = match format {
        BrowserScreenshotFormat::Braille => braille_text_from_gray_image(&image.to_luma8(), columns)?,
        BrowserScreenshotFormat::Ascii => ascii_text_from_gray_image(&image.to_luma8(), columns)?,
        BrowserScreenshotFormat::Ansi => ansi_text_from_rgb_image(&image.to_rgb8(), columns)?,
        BrowserScreenshotFormat::Text => ascii_text_from_gray_image(&image.to_luma8(), columns)?,
        BrowserScreenshotFormat::Image => unreachable!("non-image text screenshots should not use PNG rendering"),
    };
    Ok(text_screenshot_result(format, text, columns))
}

fn image_screenshot_result(png_bytes: &[u8]) -> BrowserScreenshotResult {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    BrowserScreenshotResult::Image(BrowserImageScreenshotResult {
        mime_type: "image/png".to_string(),
        data_base64: STANDARD.encode(png_bytes),
    })
}

fn browser_screenshot_result_from_png(
    png_bytes: &[u8],
    args: &Value,
) -> Result<BrowserScreenshotResult, String> {
    let options = browser_screenshot_options(args)?;
    match options.format {
        BrowserScreenshotFormat::Image => Ok(image_screenshot_result(png_bytes)),
        BrowserScreenshotFormat::Braille
        | BrowserScreenshotFormat::Ascii
        | BrowserScreenshotFormat::Ansi
        | BrowserScreenshotFormat::Text => {
            text_screenshot_result_from_png(png_bytes, options.format, options.columns)
        }
    }
}

fn capture_browser_text_snapshot(webview: &tauri::Webview) -> Result<BrowserTextLayoutSnapshot, String> {
    let wrapped = browser_drive_wrapper_script(browser_text_snapshot_script(), &Value::Null)?;
    let raw_result = evaluate_browser_script(webview, &wrapped)?;
    let envelope: BrowserDriveEnvelope = serde_json::from_str(&raw_result)
        .map_err(|error| format!("browser_drive text snapshot returned invalid JSON: {error}"))?;
    if !envelope.ok {
        return Err(
            envelope
                .error
                .unwrap_or_else(|| "browser_drive text snapshot failed".to_string()),
        );
    }
    let data = envelope
        .data
        .ok_or_else(|| "browser_drive text snapshot returned no data".to_string())?;
    serde_json::from_value(data)
        .map_err(|error| format!("browser_drive text snapshot returned invalid snapshot JSON: {error}"))
}

#[cfg(target_os = "macos")]
fn capture_browser_screenshot_png(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use std::ptr::NonNull;
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = mpsc::channel();
    webview
        .with_webview(move |platform_webview| unsafe {
            let wk_webview: &WKWebView = &*platform_webview.inner().cast();
            let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = autoreleasepool(|_| {
                    if !error.is_null() {
                        return Err((&*error).localizedDescription().to_string());
                    }
                    if image.is_null() {
                        return Err("browser screenshot returned no image".to_string());
                    }
                    let image = &*image;
                    let tiff_data = image
                        .TIFFRepresentation()
                        .ok_or_else(|| "browser screenshot returned no TIFF data".to_string())?;
                    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff_data)
                        .ok_or_else(|| "browser screenshot TIFF data could not be converted to a bitmap".to_string())?;
                    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                    let png_data = bitmap
                        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
                        .ok_or_else(|| "browser screenshot bitmap could not be encoded as PNG".to_string())?;
                    if png_data.length() == 0 {
                        return Err("browser screenshot returned empty PNG data".to_string());
                    }
                    let len = png_data.length() as usize;
                    let mut bytes = vec![0u8; len];
                    png_data.getBytes_length(NonNull::new(bytes.as_mut_ptr().cast()).unwrap(), len as _);
                    Ok(bytes)
                });
                let _ = sender.send(result);
            });
            let callback: &DynBlock<dyn Fn(*mut NSImage, *mut NSError) + 'static> = &callback;
            wk_webview.takeSnapshotWithConfiguration_completionHandler(None, callback);
        })
        .map_err(|error| format!("failed to access browser webview: {error}"))?;
    match receiver.recv_timeout(BROWSER_DRIVE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("browser_drive screenshot timed out in browser webview".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("browser_drive screenshot channel disconnected".to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn capture_browser_screenshot_png(_webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    Err("browser_drive is currently supported only on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn evaluate_browser_script(webview: &tauri::Webview, script: &str) -> Result<String, String> {
    use block2::{DynBlock, RcBlock};
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = mpsc::channel();
    let script = script.to_string();
    webview
        .with_webview(move |platform_webview| unsafe {
            let wk_webview: &WKWebView = &*platform_webview.inner().cast();
            let script = NSString::from_str(&script);
            let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = autoreleasepool(|_| {
                    if !error.is_null() {
                        return Err((&*error).localizedDescription().to_string());
                    }
                    if value.is_null() {
                        return Err("browser_drive returned no result".to_string());
                    }
                    let value = &*(value.cast::<NSString>());
                    Ok(value.to_string())
                });
                let _ = sender.send(result);
            });
            let callback: &DynBlock<dyn Fn(*mut AnyObject, *mut NSError) + 'static> = &callback;
            wk_webview.evaluateJavaScript_completionHandler(&script, Some(callback));
        })
        .map_err(|error| format!("failed to access browser webview: {error}"))?;
    match receiver.recv_timeout(BROWSER_DRIVE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            Err("browser_drive evaluation timed out in browser webview".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("browser_drive evaluation channel disconnected".to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn evaluate_browser_script(_webview: &tauri::Webview, _script: &str) -> Result<String, String> {
    Err("browser_drive is currently supported only on macOS".to_string())
}

pub fn drive_browser_webview(
    app: &tauri::AppHandle,
    _state: &crate::state::AppState,
    pane_id: &str,
    action: &str,
    args: &Value,
) -> Result<Value, String> {
    let webview = get_browser_webview(app, pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    if action == "screenshot" {
        let options = browser_screenshot_options(args)
            .map_err(|error| format!("browser_drive {action} failed for pane {pane_id}: {error}"))?;
        let screenshot = match options.format {
            BrowserScreenshotFormat::Text => {
                let snapshot = capture_browser_text_snapshot(&webview)
                    .map_err(|error| format!("browser_drive {action} failed for pane {pane_id}: {error}"))?;
                text_screenshot_result_from_dom_snapshot(snapshot, options.columns)
            }
            BrowserScreenshotFormat::Image
            | BrowserScreenshotFormat::Braille
            | BrowserScreenshotFormat::Ascii
            | BrowserScreenshotFormat::Ansi => {
                let png_bytes = capture_browser_screenshot_png(&webview)
                    .map_err(|error| format!("browser_drive {action} failed for pane {pane_id}: {error}"))?;
                browser_screenshot_result_from_png(&png_bytes, args)
            }
        }
        .map_err(|error| format!("browser_drive {action} failed for pane {pane_id}: {error}"))?;
        return serde_json::to_value(screenshot)
            .map_err(|error| format!("browser_drive {action} returned invalid screenshot JSON: {error}"));
    }
    let action_script = browser_drive_action_script(action, args)?;
    let wrapped = browser_drive_wrapper_script(&action_script, args)?;
    let raw_result = evaluate_browser_script(&webview, &wrapped)
        .map_err(|error| format!("browser_drive {action} failed for pane {pane_id}: {error}"))?;
    let envelope: BrowserDriveEnvelope = serde_json::from_str(&raw_result)
        .map_err(|error| format!("browser_drive {action} returned invalid JSON: {error}"))?;
    if envelope.ok {
        Ok(envelope.data.unwrap_or(Value::Null))
    } else {
        Err(envelope
            .error
            .unwrap_or_else(|| format!("browser_drive {action} failed for pane {pane_id}")))
    }
}

pub fn call_browser_extension(
    app: &tauri::AppHandle,
    pane_id: &str,
    method: &str,
    args: &Value,
    caller: &BrowserExtensionCallerContext,
) -> Result<Value, String> {
    let webview = get_browser_webview(app, pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    let extension = browser_extension_info_for_pane(app, pane_id)
        .ok_or_else(|| format!("browser tile {pane_id} is not hosting a browser extension page"))?;
    if !extension.methods.iter().any(|candidate| candidate.name == method) {
        return Err(format!(
            "browser extension {} does not expose method {}",
            extension.extension_id,
            method,
        ));
    }
    let script = browser_extension_call_script(method, args, caller)?;
    let raw_result = evaluate_browser_script(&webview, &script)
        .map_err(|error| format!("browser extension call {method} failed for pane {pane_id}: {error}"))?;
    let envelope: BrowserExtensionEnvelope = serde_json::from_str(&raw_result)
        .map_err(|error| format!("browser extension call {method} returned invalid JSON: {error}"))?;
    if envelope.ok {
        let data = envelope.data.unwrap_or(Value::Null);
        if method == "screenshot" {
            let screenshot = browser_extension_screenshot_result_from_value(data, args)
                .map_err(|error| format!("browser extension call {method} failed for pane {pane_id}: {error}"))?;
            serde_json::to_value(screenshot).map_err(|error| {
                format!("browser extension call {method} returned invalid screenshot JSON: {error}")
            })
        } else {
            Ok(data)
        }
    } else {
        Err(envelope
            .error
            .unwrap_or_else(|| format!("browser extension call {method} failed for pane {pane_id}")))
    }
}

fn ensure_browser_webview(
    app: &tauri::AppHandle,
    pane_id: &str,
    initial_url: Option<&str>,
    viewport: &BrowserViewport,
) -> Result<tauri::Webview, String> {
    if let Some(existing) = get_browser_webview(app, pane_id) {
        return Ok(existing);
    }

    let label = browser_webview_label(pane_id);
    let start_url = parse_browser_url(initial_url)?;
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "main window is not available".to_string())?;
    let app_handle = app.clone();
    let pane_id_for_event = pane_id.to_string();
    let pane_id_for_zoom = pane_id.to_string();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(start_url.clone())).on_page_load(
        move |webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_browser_url_changed(
                &app_handle,
                &pane_id_for_event,
                payload.url().to_string(),
                loading,
            );
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let state = app_handle.state::<crate::state::AppState>();
                let page_zoom = state
                    .browser_page_zoom(&pane_id_for_zoom)
                    .unwrap_or(DEFAULT_BROWSER_PAGE_ZOOM);
                if let Err(error) = apply_browser_page_zoom(&webview, page_zoom) {
                    log::warn!("Failed to reapply browser page zoom for pane {}: {}", pane_id_for_zoom, error);
                }
            }
        },
    );
    if browser_tile_incognito(app, pane_id) {
        builder = builder.incognito(true);
    }

    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(viewport.x, viewport.y),
            LogicalSize::new(viewport.width.max(1.0), viewport.height.max(1.0)),
        )
        .map_err(|error| format!("failed to create browser webview: {error}"))?;
    webview
        .set_auto_resize(false)
        .map_err(|error| format!("failed to disable browser auto-resize: {error}"))?;
    emit_browser_url_changed(app, pane_id, start_url.to_string(), true);
    Ok(webview)
}

#[cfg(test)]
mod braille_tests {
    use super::*;
    use image::{Luma, Rgb, RgbImage};
    use std::io::Cursor;

    fn encode_test_png_base64(image: &RgbImage) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;

        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image.clone())
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .expect("encode png");
        STANDARD.encode(bytes)
    }

    #[test]
    fn renders_dark_pixels_as_braille_on_light_background() {
        let mut image = GrayImage::from_pixel(2, 4, Luma([255]));
        image.put_pixel(0, 0, Luma([0]));
        let art = braille_text_from_gray_image(&image, 1).unwrap();
        assert_eq!(art, "⠁");
    }

    #[test]
    fn renders_light_pixels_as_braille_on_dark_background() {
        let mut image = GrayImage::from_pixel(2, 4, Luma([0]));
        image.put_pixel(0, 0, Luma([255]));
        let art = braille_text_from_gray_image(&image, 1).unwrap();
        assert_eq!(art, "⠁");
    }

    #[test]
    fn dithers_mid_gray_pixels_into_partial_braille_patterns() {
        let image = GrayImage::from_pixel(2, 4, Luma([160]));
        let art = braille_text_from_gray_image(&image, 1).unwrap();
        assert_ne!(art, BRAILLE_BLANK.to_string());
        assert_ne!(art, "⣿");
    }

    #[test]
    fn renders_ascii_screenshot_text_for_grayscale_inputs() {
        let mut image = GrayImage::from_pixel(4, 4, Luma([255]));
        image.put_pixel(0, 0, Luma([0]));
        image.put_pixel(3, 3, Luma([64]));
        let art = ascii_text_from_gray_image(&image, 4).unwrap();
        assert!(!art.trim().is_empty());
        assert!(art.lines().count() > 0);
    }

    #[test]
    fn renders_ansi_screenshot_text_with_escape_sequences() {
        let mut image = RgbImage::from_pixel(2, 2, Rgb([255, 255, 255]));
        image.put_pixel(0, 0, Rgb([255, 0, 0]));
        let art = ansi_text_from_rgb_image(&image, 2).unwrap();
        assert!(art.contains("\u{1b}["));
        assert!(art.contains("▀") || art.contains("▄") || art.contains("█"));
    }

    #[test]
    fn parses_text_screenshot_format_with_columns() {
        let args = serde_json::json!({
            "format": "text",
            "columns": 96
        });
        let options = browser_screenshot_options(&args).unwrap();
        assert_eq!(options.format, BrowserScreenshotFormat::Text);
        assert_eq!(options.columns, 96);
    }

    #[test]
    fn parses_braille_browser_preview_format_with_columns() {
        let columns = Value::from(72);
        let options = browser_preview_options(Some("braille"), Some(&columns)).unwrap();
        assert_eq!(options.format, BrowserScreenshotFormat::Braille);
        assert_eq!(options.columns, 72);
    }

    #[test]
    fn rejects_image_format_for_browser_preview() {
        let columns = Value::from(72);
        let error = browser_preview_options(Some("image"), Some(&columns)).unwrap_err();
        assert!(error.contains("browser preview requires `format`"));
    }

    #[test]
    fn renders_text_screenshot_from_layout_fragments() {
        let snapshot = BrowserTextLayoutSnapshot {
            viewport_width: 800.0,
            viewport_height: 400.0,
            fragments: vec![
                BrowserTextLayoutFragment {
                    text: "SCORE 1200".to_string(),
                    left: 20.0,
                    top: 20.0,
                    width: 160.0,
                    height: 24.0,
                },
                BrowserTextLayoutFragment {
                    text: "LIVES x3".to_string(),
                    left: 620.0,
                    top: 22.0,
                    width: 120.0,
                    height: 24.0,
                },
                BrowserTextLayoutFragment {
                    text: "PRESS START".to_string(),
                    left: 180.0,
                    top: 220.0,
                    width: 220.0,
                    height: 26.0,
                },
            ],
        };

        let result = text_screenshot_result_from_dom_snapshot(snapshot, 80).unwrap();
        let BrowserScreenshotResult::Text(payload) = result else {
            panic!("expected text screenshot result");
        };
        assert_eq!(payload.format, "text");
        assert_eq!(payload.columns, 80);
        let lines = payload.text.lines().collect::<Vec<_>>();
        let score_row = lines
            .iter()
            .position(|line| line.contains("SCORE 1200"))
            .expect("score row");
        let lives_row = lines
            .iter()
            .position(|line| line.contains("LIVES x3"))
            .expect("lives row");
        let prompt_row = lines
            .iter()
            .position(|line| line.contains("PRESS START"))
            .expect("prompt row");
        assert!((score_row as isize - lives_row as isize).abs() <= 1);
        assert!(prompt_row > score_row + 4);
        let score_col = lines[score_row].find("SCORE 1200").expect("score column");
        let lives_col = lines[lives_row].find("LIVES x3").expect("lives column");
        assert!(lives_col > score_col + 20);
    }

    #[test]
    fn decodes_extension_png_screenshot_sources() {
        let image = RgbImage::from_pixel(2, 2, Rgb([32, 64, 96]));
        let result = browser_extension_screenshot_result_from_value(
            serde_json::json!({
                "kind": "png_base64",
                "mime_type": "image/png",
                "data_base64": encode_test_png_base64(&image),
            }),
            &serde_json::json!({}),
        )
        .unwrap();
        let BrowserScreenshotResult::Image(payload) = result else {
            panic!("expected image screenshot result");
        };
        assert_eq!(payload.mime_type, "image/png");
        assert!(!payload.data_base64.is_empty());
    }

    #[test]
    fn renders_text_extension_screenshot_from_png() {
        let mut image = RgbImage::from_pixel(4, 4, Rgb([255, 255, 255]));
        image.put_pixel(0, 0, Rgb([0, 0, 0]));
        image.put_pixel(3, 3, Rgb([32, 32, 32]));
        let result = browser_extension_screenshot_result_from_value(
            serde_json::json!({
                "kind": "png_base64",
                "mime_type": "image/png",
                "data_base64": encode_test_png_base64(&image),
            }),
            &serde_json::json!({
                "format": "text",
                "columns": 10,
            }),
        )
        .unwrap();
        let BrowserScreenshotResult::Text(payload) = result else {
            panic!("expected text screenshot result");
        };
        assert_eq!(payload.format, "text");
        assert_eq!(payload.columns, 10);
        assert!(payload.rows > 0);
        assert!(!payload.text.trim().is_empty());
    }
}

pub fn close_browser_webview(app: &tauri::AppHandle, pane_id: &str) {
    let state = app.state::<crate::state::AppState>();
    state.remove_browser_page_zoom(pane_id);
    if let Some(webview) = get_browser_webview(app, pane_id) {
        let _ = webview.close();
    }
}

fn navigate_existing_browser_webview(
    app: &tauri::AppHandle,
    pane_id: &str,
    parsed: Url,
) -> Result<BrowserWebviewState, String> {
    let webview = get_browser_webview(app, pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    webview
        .navigate(parsed.clone())
        .map_err(|error| format!("failed to navigate browser webview: {error}"))?;
    emit_browser_url_changed(app, pane_id, parsed.to_string(), true);
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

pub fn navigate_browser_webview(
    app: &tauri::AppHandle,
    pane_id: &str,
    url: &str,
) -> Result<BrowserWebviewState, String> {
    let parsed = parse_browser_url(Some(url))?;
    if get_browser_webview(app, pane_id).is_some() {
        return navigate_existing_browser_webview(app, pane_id, parsed);
    }

    let hidden = hidden_browser_viewport();
    let webview = ensure_browser_webview(app, pane_id, Some(parsed.as_str()), &hidden)?;
    apply_browser_viewport(app, pane_id, &webview, &hidden)?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

pub fn load_browser_webview(
    app: &tauri::AppHandle,
    pane_id: &str,
    path: &str,
) -> Result<BrowserWebviewState, String> {
    let parsed = resolve_browser_file_url(path)?;
    if get_browser_webview(app, pane_id).is_some() {
        return navigate_existing_browser_webview(app, pane_id, parsed);
    }

    let hidden = hidden_browser_viewport();
    let webview = ensure_browser_webview(app, pane_id, Some(parsed.as_str()), &hidden)?;
    apply_browser_viewport(app, pane_id, &webview, &hidden)?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

#[tauri::command]
pub async fn browser_webview_sync(
    app: tauri::AppHandle,
    pane_id: String,
    initial_url: Option<String>,
    viewport: BrowserViewport,
) -> Result<BrowserWebviewState, String> {
    let webview = ensure_browser_webview(&app, &pane_id, initial_url.as_deref(), &viewport)?;
    apply_browser_viewport(&app, &pane_id, &webview, &viewport)?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

#[tauri::command]
pub async fn browser_webview_navigate(
    app: tauri::AppHandle,
    pane_id: String,
    url: String,
) -> Result<BrowserWebviewState, String> {
    navigate_browser_webview(&app, &pane_id, &url)
}

#[tauri::command]
pub async fn browser_webview_load(
    app: tauri::AppHandle,
    pane_id: String,
    path: String,
) -> Result<BrowserWebviewState, String> {
    load_browser_webview(&app, &pane_id, &path)
}

#[tauri::command]
pub async fn browser_webview_reload(
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<BrowserWebviewState, String> {
    let webview = get_browser_webview(&app, &pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    webview
        .reload()
        .map_err(|error| format!("failed to reload browser webview: {error}"))?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

#[tauri::command]
pub async fn browser_webview_back(
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<BrowserWebviewState, String> {
    let webview = get_browser_webview(&app, &pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    webview
        .eval("window.history.back();")
        .map_err(|error| format!("failed to navigate browser history backward: {error}"))?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

#[tauri::command]
pub async fn browser_webview_forward(
    app: tauri::AppHandle,
    pane_id: String,
) -> Result<BrowserWebviewState, String> {
    let webview = get_browser_webview(&app, &pane_id)
        .ok_or_else(|| format!("browser webview not found for pane {pane_id}"))?;
    webview
        .eval("window.history.forward();")
        .map_err(|error| format!("failed to navigate browser history forward: {error}"))?;
    Ok(BrowserWebviewState {
        current_url: browser_current_url(&webview)?,
    })
}

#[tauri::command]
pub async fn browser_webview_hide(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    if let Some(webview) = get_browser_webview(&app, &pane_id) {
        webview
            .hide()
            .map_err(|error| format!("failed to hide browser webview: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_webview_preview(
    app: tauri::AppHandle,
    pane_id: String,
    format: Option<String>,
    columns: Option<u32>,
) -> Result<BrowserTextScreenshotResult, String> {
    let columns_value = columns.map(Value::from);
    let options = browser_preview_options(format.as_deref(), columns_value.as_ref())?;
    browser_preview_result(&app, &pane_id, options.format, options.columns)
}

#[cfg(test)]
mod tests {
    use super::{parse_browser_url, resolve_browser_file_url, sanitize_browser_page_zoom};

    #[test]
    fn allows_file_scheme_browser_urls() {
        let url = parse_browser_url(Some("file:///tmp/herd-browser-test.html")).unwrap();
        assert_eq!(url.scheme(), "file");
    }

    #[test]
    fn resolves_relative_browser_file_urls_from_project_root() {
        let url = resolve_browser_file_url("src-tauri/Cargo.toml").unwrap();
        assert_eq!(url.scheme(), "file");
        assert!(url.path().ends_with("/src-tauri/Cargo.toml"));
    }

    #[test]
    fn rejects_missing_browser_file_paths() {
        let error = resolve_browser_file_url("this-file-should-not-exist-3c7f5d84.html").unwrap_err();
        assert!(error.contains("failed to resolve browser path"));
    }

    #[test]
    fn sanitizes_invalid_browser_page_zoom() {
        assert_eq!(sanitize_browser_page_zoom(0.0), 1.0);
        assert_eq!(sanitize_browser_page_zoom(f64::NAN), 1.0);
        assert_eq!(sanitize_browser_page_zoom(f64::INFINITY), 1.0);
    }

    #[test]
    fn clamps_browser_page_zoom_to_supported_range() {
        assert_eq!(sanitize_browser_page_zoom(0.1), 0.25);
        assert_eq!(sanitize_browser_page_zoom(40.0), 20.0);
        assert_eq!(sanitize_browser_page_zoom(0.5), 0.5);
    }
}
