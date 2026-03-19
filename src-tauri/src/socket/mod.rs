pub mod protocol;
pub mod server;

pub fn socket_path() -> &'static str {
    crate::runtime::socket_path()
}
