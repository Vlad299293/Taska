//! Команды Tauri для режима cowork. Вся логика (права, участники, данные) живёт в интерфейсе,
//! здесь только сеть: слушать порт, передавать тексты и искать хосты в локальной сети.

use std::sync::Arc;
use std::time::Duration;

use cowork_net::{DEFAULT_PORT, Event, Found, HostInfo, Responder, Server};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

const EVENT_NAME: &str = "cowork-event";
const SCAN_WAIT: Duration = Duration::from_millis(1200);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Payload {
    Connected { conn: u64 },
    Text { conn: u64, text: String },
    Closed { conn: u64 },
}

struct Running {
    server: Arc<Server>,
    // Ответчик может не запуститься (порт занят другим экземпляром): тогда хост просто не виден при поиске
    _responder: Option<Responder>,
    pump: JoinHandle<()>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.pump.abort();
    }
}

#[derive(Default)]
pub struct CoworkState {
    running: Mutex<Option<Running>>,
}

/// Запускает хост и возвращает порт, на котором он слушает.
#[tauri::command]
pub async fn cowork_host_start(app: AppHandle, state: State<'_, CoworkState>, name: String, host_id: String) -> Result<u16, String> {
    let mut slot = state.running.lock().await;
    if let Some(existing) = slot.as_ref() {
        return Ok(existing.server.port());
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Arc::new(Server::start(DEFAULT_PORT, tx).await.map_err(|e| format!("Не удалось открыть порт: {e}"))?);
    let port = server.port();
    let responder = Responder::start(HostInfo::new(&name, port, &host_id)).await.ok();

    let pump = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let payload = match event {
                Event::Connected { conn } => Payload::Connected { conn },
                Event::Text { conn, text } => Payload::Text { conn, text },
                Event::Closed { conn } => Payload::Closed { conn },
            };
            let _ = app.emit(EVENT_NAME, payload);
        }
    });

    *slot = Some(Running { server, _responder: responder, pump });
    Ok(port)
}

#[tauri::command]
pub async fn cowork_host_stop(state: State<'_, CoworkState>) -> Result<(), String> {
    // Drop закрывает всех подключённых и освобождает порты; накопленные сообщения успевают уйти
    let running = state.running.lock().await.take();
    if let Some(running) = running {
        running.server.shutdown();
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cowork_send(state: State<'_, CoworkState>, conn: u64, text: String) -> Result<(), String> {
    match state.running.lock().await.as_ref() {
        Some(r) if r.server.send(conn, text) => Ok(()),
        _ => Err("Соединение уже закрыто".into()),
    }
}

#[tauri::command]
pub async fn cowork_kick(state: State<'_, CoworkState>, conn: u64) -> Result<(), String> {
    if let Some(r) = state.running.lock().await.as_ref() {
        r.server.kick(conn);
    }
    Ok(())
}

/// Ищет хосты в локальной сети.
#[tauri::command]
pub async fn cowork_scan() -> Result<Vec<Found>, String> {
    cowork_net::scan(SCAN_WAIT).await.map_err(|e| format!("Не удалось выполнить поиск в сети: {e}"))
}

/// Адреса этого компьютера в локальной сети (для ручного подключения гостя).
#[tauri::command]
pub fn cowork_local_addresses() -> Vec<String> {
    cowork_net::local_addresses()
}
