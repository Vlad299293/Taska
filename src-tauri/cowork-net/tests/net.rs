use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use cowork_net::discovery::{self, HostInfo, Responder};
use cowork_net::{Event, Server};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

const WAIT: Duration = Duration::from_secs(3);

async fn next(rx: &mut mpsc::UnboundedReceiver<Event>) -> Event {
    timeout(WAIT, rx.recv()).await.expect("событие не пришло вовремя").expect("канал закрыт")
}

#[tokio::test]
async fn text_flows_both_ways_and_close_is_reported() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, tx).await.unwrap();
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{}", server.port())).await.unwrap();

    let Event::Connected { conn } = next(&mut rx).await else { panic!("ждали Connected") };

    ws.send(Message::text("привет")).await.unwrap();
    assert_eq!(next(&mut rx).await, Event::Text { conn, text: "привет".into() });

    assert!(server.send(conn, "ответ".into()));
    let msg = timeout(WAIT, ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(msg.into_text().unwrap().as_str(), "ответ");

    ws.close(None).await.unwrap();
    assert_eq!(next(&mut rx).await, Event::Closed { conn });
    assert!(!server.send(conn, "никому".into()));
}

#[tokio::test]
async fn kick_delivers_queued_messages_before_closing() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, tx).await.unwrap();
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{}", server.port())).await.unwrap();
    let Event::Connected { conn } = next(&mut rx).await else { panic!() };

    server.send(conn, "последнее".into());
    server.kick(conn);

    let first = timeout(WAIT, ws.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(first.into_text().unwrap().as_str(), "последнее");
    let second = timeout(WAIT, ws.next()).await.unwrap();
    assert!(matches!(second, Some(Ok(Message::Close(_))) | None | Some(Err(_))));
    assert_eq!(next(&mut rx).await, Event::Closed { conn });
}

#[tokio::test]
async fn oversized_messages_drop_the_connection() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, tx).await.unwrap();
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{}", server.port())).await.unwrap();
    let Event::Connected { conn } = next(&mut rx).await else { panic!() };

    let _ = ws.send(Message::text("x".repeat(300 * 1024))).await;
    assert_eq!(next(&mut rx).await, Event::Closed { conn });
}

#[tokio::test]
async fn shutdown_closes_everyone_and_frees_the_port() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, tx).await.unwrap();
    let port = server.port();
    let (_ws, _) = connect_async(format!("ws://127.0.0.1:{port}")).await.unwrap();
    let Event::Connected { conn } = next(&mut rx).await else { panic!() };

    server.shutdown();
    assert_eq!(next(&mut rx).await, Event::Closed { conn });
    drop(server);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(connect_async(format!("ws://127.0.0.1:{port}")).await.is_err());
}

#[tokio::test]
async fn busy_port_falls_back_to_a_free_one() {
    let (tx1, _rx1) = mpsc::unbounded_channel();
    let (tx2, _rx2) = mpsc::unbounded_channel();
    let first = Server::start(0, tx1).await.unwrap();
    let second = Server::start(first.port(), tx2).await.unwrap();
    assert_ne!(first.port(), second.port());
}

#[tokio::test]
async fn silent_connections_do_not_block_the_server() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let server = Server::start(0, tx).await.unwrap();
    // «Мёртвое» TCP-соединение без рукопожатия
    let _idle = tokio::net::TcpStream::connect(("127.0.0.1", server.port())).await.unwrap();
    let (_ws, _) = connect_async(format!("ws://127.0.0.1:{}", server.port())).await.unwrap();
    assert!(matches!(next(&mut rx).await, Event::Connected { .. }));
}

#[tokio::test]
async fn host_is_found_by_scan_and_stops_answering_when_dropped() {
    let probe_port = 47990;
    let info = HostInfo::new("Анна", 47821, "ws-1");
    let responder = Responder::start_on(probe_port, info).await.unwrap();
    let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), probe_port);

    let found = discovery::scan_targets(&[target], Duration::from_millis(300)).await.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].name, "Анна");
    assert_eq!(found[0].port, 47821);
    assert_eq!(found[0].host_id, "ws-1");
    assert_eq!(found[0].address, "127.0.0.1");

    drop(responder);
    tokio::time::sleep(Duration::from_millis(50)).await;
    let found = discovery::scan_targets(&[target], Duration::from_millis(200)).await.unwrap();
    assert!(found.is_empty());
}

#[tokio::test]
async fn garbage_replies_are_ignored() {
    let fake = tokio::net::UdpSocket::bind("127.0.0.1:47991").await.unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 64];
        while let Ok((_, from)) = fake.recv_from(&mut buf).await {
            let _ = fake.send_to(b"not json", from).await;
            let _ = fake.send_to(br#"{"v":99,"name":"x","port":1,"hostId":"h"}"#, from).await;
        }
    });
    let target: SocketAddr = "127.0.0.1:47991".parse().unwrap();
    let found = discovery::scan_targets(&[target], Duration::from_millis(300)).await.unwrap();
    assert!(found.is_empty());
}
