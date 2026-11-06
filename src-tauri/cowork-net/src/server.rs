use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::accept_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// Порт хоста по умолчанию. Если он занят, берётся любой свободный.
pub const DEFAULT_PORT: u16 = 47821;

/// Предел размера одного сообщения: задачи и блоки маленькие, всё большее считаем мусором.
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Предел одновременных соединений: рабочая группа, а не публичный сервер.
const MAX_CONNECTIONS: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const PING_EVERY: Duration = Duration::from_secs(15);

/// Что происходит на соединениях. `conn` — номер соединения, выдаётся сервером.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Connected { conn: u64 },
    Text { conn: u64, text: String },
    Closed { conn: u64 },
}

enum Out {
    Text(String),
    Close,
}

#[derive(Default)]
struct Shared {
    conns: Mutex<HashMap<u64, mpsc::UnboundedSender<Out>>>,
    next: AtomicU64,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::UnboundedSender<Out>>> {
        // Отравленный замок здесь не страшен: внутри только список отправителей
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Server {
    port: u16,
    shared: Arc<Shared>,
    accept: JoinHandle<()>,
}

impl Server {
    /// Начинает слушать `port` на всех интерфейсах. Если порт занят, выбирает свободный.
    pub async fn start(port: u16, events: mpsc::UnboundedSender<Event>) -> io::Result<Server> {
        let listener = match TcpListener::bind(("0.0.0.0", port)).await {
            Ok(l) => l,
            Err(e) if e.kind() == io::ErrorKind::AddrInUse && port != 0 => TcpListener::bind(("0.0.0.0", 0)).await?,
            Err(e) => return Err(e),
        };
        let port = listener.local_addr()?.port();
        let shared = Arc::new(Shared::default());

        let accept = tokio::spawn({
            let shared = shared.clone();
            async move {
                loop {
                    let Ok((stream, addr)) = listener.accept().await else {
                        // Временные сбои accept (например, кончились дескрипторы) не должны убивать сервер
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    };
                    if shared.lock().len() >= MAX_CONNECTIONS {
                        continue; // сокет закроется при выходе из области видимости
                    }
                    tokio::spawn(handle_connection(stream, addr, shared.clone(), events.clone()));
                }
            }
        });

        Ok(Server { port, shared, accept })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Отправляет текст одному соединению. false, если такого соединения уже нет.
    pub fn send(&self, conn: u64, text: String) -> bool {
        self.shared.lock().get(&conn).is_some_and(|tx| tx.send(Out::Text(text)).is_ok())
    }

    /// Вежливо закрывает соединение: уже отправленные сообщения успевают дойти.
    pub fn kick(&self, conn: u64) {
        if let Some(tx) = self.shared.lock().get(&conn) {
            let _ = tx.send(Out::Close);
        }
    }

    /// Перестаёт принимать новых и закрывает всех подключённых.
    pub fn shutdown(&self) {
        self.accept.abort();
        for tx in self.shared.lock().values() {
            let _ = tx.send(Out::Close);
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

async fn handle_connection(stream: TcpStream, _addr: SocketAddr, shared: Arc<Shared>, events: mpsc::UnboundedSender<Event>) {
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_async_with_config(stream, Some(config))).await;
    let Ok(Ok(ws)) = handshake else { return };

    let conn = shared.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
    shared.lock().insert(conn, tx);
    let _ = events.send(Event::Connected { conn });

    let (mut sink, mut stream) = ws.split();

    let write = async {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(Out::Text(text)) => {
                        if sink.send(Message::text(text)).await.is_err() { break; }
                    }
                    Some(Out::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                },
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Default::default())).await.is_err() { break; }
                }
            }
        }
    };

    let read = async {
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    let _ = events.send(Event::Text { conn, text: text.as_str().to_owned() });
                }
                Message::Close(_) => break,
                _ => {} // ping/pong обрабатывает библиотека, бинарные данные не принимаем
            }
        }
    };

    // Как только закончился любой из концов, соединение считается закрытым
    tokio::select! { _ = write => {}, _ = read => {} }

    shared.lock().remove(&conn);
    let _ = events.send(Event::Closed { conn });
}
