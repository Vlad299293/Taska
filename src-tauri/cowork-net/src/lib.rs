//! Сеть для режима cowork.
//!
//! Хост слушает WebSocket-порт и отвечает на поисковые UDP-запросы, гости находят хост в
//! локальной сети и подключаются к нему из интерфейса напрямую (браузерным WebSocket).
//! Крейт не знает ни про Tauri, ни про устройство данных: он только передаёт тексты туда и обратно.

pub mod discovery;
pub mod server;

pub use discovery::{DISCOVERY_PORT, Found, HostInfo, Responder, local_addresses, scan};
pub use server::{DEFAULT_PORT, Event, Server};
