use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

/// UDP-порт, на котором хост отвечает на поисковые запросы.
pub const DISCOVERY_PORT: u16 = 47822;

const PROBE: &[u8] = b"TASKA_DISCOVER_V1";
const PROTOCOL_VERSION: u32 = 1;
const MAX_NAME_CHARS: usize = 40;

/// Что хост рассказывает о себе. Кода приглашения здесь нет: его нужно получить от хоста лично.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub v: u32,
    pub name: String,
    pub port: u16,
    pub host_id: String,
}

impl HostInfo {
    pub fn new(name: &str, port: u16, host_id: &str) -> Self {
        HostInfo {
            v: PROTOCOL_VERSION,
            name: name.chars().take(MAX_NAME_CHARS).collect(),
            port,
            host_id: host_id.chars().take(64).collect(),
        }
    }
}

/// Найденный в сети хост.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub address: String,
    pub v: u32,
    pub name: String,
    pub port: u16,
    pub host_id: String,
}

/// Отвечает на поисковые запросы, пока жив. При уничтожении перестаёт отвечать.
pub struct Responder {
    task: JoinHandle<()>,
}

impl Drop for Responder {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Responder {
    pub async fn start(info: HostInfo) -> io::Result<Responder> {
        Self::start_on(DISCOVERY_PORT, info).await
    }

    pub async fn start_on(port: u16, info: HostInfo) -> io::Result<Responder> {
        let socket = UdpSocket::bind(("0.0.0.0", port)).await?;
        let reply = serde_json::to_vec(&info).map_err(io::Error::other)?;
        let task = tokio::spawn(async move {
            let mut buf = [0u8; 64];
            loop {
                let Ok((n, from)) = socket.recv_from(&mut buf).await else { continue };
                if &buf[..n] == PROBE {
                    let _ = socket.send_to(&reply, from).await;
                }
            }
        });
        Ok(Responder { task })
    }
}

/// Ищет хосты в локальной сети: рассылает запрос по всем сетевым интерфейсам и слушает ответы.
pub async fn scan(wait: Duration) -> io::Result<Vec<Found>> {
    scan_targets(&broadcast_targets(DISCOVERY_PORT), wait).await
}

/// Куда рассылать запрос: общий широковещательный адрес и широковещательный адрес каждой сети компьютера.
/// Несколько адресов нужны, потому что при VPN или виртуальных адаптерах общий адрес уходит не туда.
pub fn broadcast_targets(port: u16) -> Vec<SocketAddr> {
    let mut targets = vec![SocketAddr::new(IpAddr::V4(Ipv4Addr::BROADCAST), port)];
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = &iface.addr {
                if let Some(b) = v4.broadcast {
                    let addr = SocketAddr::new(IpAddr::V4(b), port);
                    if !targets.contains(&addr) {
                        targets.push(addr);
                    }
                }
            }
        }
    }
    targets
}

/// IPv4-адреса этого компьютера в локальных сетях. Гость может ввести такой адрес вручную,
/// если роутер не пропускает поисковые рассылки.
pub fn local_addresses() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = &iface.addr {
                let ip = v4.ip.to_string();
                // 169.254.x.x — адреса без настроенной сети, по ним никто не подключится
                if !ip.starts_with("169.254.") && !out.contains(&ip) {
                    out.push(ip);
                }
            }
        }
    }
    out
}

pub async fn scan_targets(targets: &[SocketAddr], wait: Duration) -> io::Result<Vec<Found>> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).await?;
    socket.set_broadcast(true)?;
    for target in targets {
        // Отдельные сети могут быть недоступны (отключённый адаптер): это не повод отменять поиск
        let _ = socket.send_to(PROBE, target).await;
    }

    let mut found: Vec<Found> = Vec::new();
    let deadline = tokio::time::Instant::now() + wait;
    let mut buf = [0u8; 1024];
    loop {
        let Ok(Ok((n, from))) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await else { break };
        let Ok(info) = serde_json::from_slice::<HostInfo>(&buf[..n]) else { continue };
        if info.v != PROTOCOL_VERSION || info.port == 0 {
            continue;
        }
        let address = from.ip().to_string();
        // Один хост может ответить через несколько интерфейсов
        if found.iter().any(|f| f.host_id == info.host_id && f.address == address) {
            continue;
        }
        found.push(Found { address, v: info.v, name: info.name, port: info.port, host_id: info.host_id });
    }
    Ok(found)
}
