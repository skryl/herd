use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserViewport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWebviewState {
    pub current_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserUrlChangedEvent {
    pane_id: String,
    url: String,
    loading: bool,
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
    }
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

fn apply_browser_viewport(
    webview: &tauri::Webview,
    viewport: &BrowserViewport,
) -> Result<(), String> {
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

#[derive(Debug, Deserialize)]
struct BrowserDriveEnvelope {
    ok: bool,
    #[serde(default)]
    data: Option<Value>,
    #[serde(default)]
    error: Option<String>,
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
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(start_url.clone())).on_page_load(
        move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_browser_url_changed(
                &app_handle,
                &pane_id_for_event,
                payload.url().to_string(),
                loading,
            );
        },
    );

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

pub fn close_browser_webview(app: &tauri::AppHandle, pane_id: &str) {
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
    apply_browser_viewport(&webview, &hidden)?;
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
    apply_browser_viewport(&webview, &hidden)?;
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
    apply_browser_viewport(&webview, &viewport)?;
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

#[cfg(test)]
mod tests {
    use super::{parse_browser_url, resolve_browser_file_url};

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
}
