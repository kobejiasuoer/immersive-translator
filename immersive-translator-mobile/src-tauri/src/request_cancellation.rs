//! BYOK cancellation: one handle per command kind and client request ID.
use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CANCELLED: &str = "请求已取消";
const PENDING_TTL: Duration = Duration::from_secs(60);
const MAX_PENDING: usize = 512;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RequestKind {
    Translate,
    Chat,
    Dictionary,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum RequestId {
    Client(String),
    Legacy(u64),
}
type RequestKey = (RequestKind, RequestId);

#[derive(Default)]
struct State {
    active: HashMap<RequestKey, AbortHandle>,
    // IPC dispatch may deliver cancellation before the async request is polled.
    // Keep only bounded, short-lived markers; never retain text or credentials.
    pending: HashMap<RequestKey, Instant>,
}

#[derive(Default)]
struct Registry {
    state: Mutex<State>,
    sequence: AtomicU64,
}

impl Registry {
    fn begin(&self, kind: RequestKind, req_id: Option<&str>) -> Result<NativeRequest<'_>, String> {
        let id = match req_id {
            Some(id) => {
                validate(id)?;
                RequestId::Client(id.to_owned())
            }
            None => RequestId::Legacy(self.sequence.fetch_add(1, Ordering::Relaxed)),
        };
        let key = (kind, id);
        let mut state = self
            .state
            .lock()
            .map_err(|_| "请求状态锁异常".to_string())?;
        state.pending.retain(|_, time| time.elapsed() < PENDING_TTL);
        if state.pending.contains_key(&key) {
            return Err(CANCELLED.into());
        }
        if state.active.contains_key(&key) {
            return Err("请求标识重复".into());
        }
        let (handle, registration) = AbortHandle::new_pair();
        state.active.insert(key.clone(), handle);
        Ok(NativeRequest {
            registry: self,
            key,
            registration: Some(registration),
        })
    }

    fn cancel(&self, kind: RequestKind, req_id: Option<&str>) -> Result<(), String> {
        if let Some(id) = req_id {
            validate(id)?;
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| "请求状态锁异常".to_string())?;
        state.pending.retain(|_, time| time.elapsed() < PENDING_TTL);
        if let Some(id) = req_id {
            let key = (kind, RequestId::Client(id.to_owned()));
            if let Some(handle) = state.active.get(&key) {
                // Retain until the owning guard drops: a duplicate invocation
                // cannot replace this handle while cancellation is completing.
                handle.abort();
            } else {
                if state.pending.len() >= MAX_PENDING {
                    if let Some(oldest) = state
                        .pending
                        .iter()
                        .min_by_key(|(_, time)| **time)
                        .map(|(key, _)| key.clone())
                    {
                        state.pending.remove(&oldest);
                    }
                }
                state.pending.insert(key, Instant::now());
            }
        } else {
            // Compatibility with the previous no-argument abort commands.
            for ((active_kind, _), handle) in &state.active {
                if *active_kind == kind {
                    handle.abort();
                }
            }
        }
        Ok(())
    }
}

fn validate(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 128 {
        return Err("请求标识无效".into());
    }
    Ok(())
}

pub struct NativeRequest<'a> {
    registry: &'a Registry,
    key: RequestKey,
    registration: Option<AbortRegistration>,
}
impl NativeRequest<'_> {
    pub async fn run<T>(
        mut self,
        operation: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let registration = self
            .registration
            .take()
            .expect("request registration is used once");
        Abortable::new(operation, registration)
            .await
            .unwrap_or_else(|_| Err(CANCELLED.into()))
    }
}
impl Drop for NativeRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.registry.state.lock() {
            state.active.remove(&self.key);
        }
    }
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();
pub fn begin(kind: RequestKind, req_id: Option<&str>) -> Result<NativeRequest<'static>, String> {
    REGISTRY.get_or_init(Registry::default).begin(kind, req_id)
}
pub fn cancel(kind: RequestKind, req_id: Option<&str>) -> Result<(), String> {
    REGISTRY.get_or_init(Registry::default).cancel(kind, req_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::FutureExt;

    #[tokio::test]
    async fn targeted_abort_does_not_stop_a_concurrent_translation() {
        let registry = Registry::default();
        let first = registry
            .begin(RequestKind::Translate, Some("first"))
            .unwrap();
        let second = registry
            .begin(RequestKind::Translate, Some("second"))
            .unwrap();
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut first = Box::pin(first.run(std::future::pending::<Result<&str, String>>()));
        let mut second = Box::pin(second.run(async { receive.await.map_err(|_| "closed".into()) }));
        assert!(first.as_mut().now_or_never().is_none());
        assert!(second.as_mut().now_or_never().is_none());
        registry
            .cancel(RequestKind::Translate, Some("first"))
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), first)
                .await
                .unwrap(),
            Err(CANCELLED.into())
        );
        assert!(second.as_mut().now_or_never().is_none());
        send.send("second completed").unwrap();
        assert_eq!(second.await.unwrap(), "second completed");
        assert!(registry.state.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn eight_concurrent_requests_only_cancel_the_selected_id() {
        let registry = Registry::default();
        let mut sends = Vec::new();
        let mut requests = Vec::new();
        for index in 0..8 {
            let id = format!("concurrent-{index}");
            let request = registry.begin(RequestKind::Translate, Some(&id)).unwrap();
            let (send, receive) = tokio::sync::oneshot::channel();
            sends.push(send);
            requests.push(Box::pin(
                request.run(async { receive.await.map_err(|_| "closed".into()) }),
            ));
        }
        for request in &mut requests {
            assert!(request.as_mut().now_or_never().is_none());
        }
        registry
            .cancel(RequestKind::Translate, Some("concurrent-3"))
            .unwrap();
        for (index, request) in requests.iter_mut().enumerate() {
            if index != 3 {
                assert!(request.as_mut().now_or_never().is_none());
            }
        }
        for (index, send) in sends.into_iter().enumerate() {
            let _ = send.send(index);
        }
        let results = futures_util::future::join_all(requests).await;
        for (index, result) in results.into_iter().enumerate() {
            assert_eq!(
                result,
                if index == 3 {
                    Err(CANCELLED.into())
                } else {
                    Ok(index)
                }
            );
        }
        assert!(registry.state.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn abort_interrupts_a_request_before_headers_or_another_chunk_arrives() {
        let registry = Registry::default();
        let request = registry.begin(RequestKind::Chat, Some("waiting")).unwrap();
        let mut waiting = Box::pin(request.run(std::future::pending::<Result<(), String>>()));
        assert!(waiting.as_mut().now_or_never().is_none());
        registry.cancel(RequestKind::Chat, Some("waiting")).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), waiting)
                .await
                .unwrap(),
            Err(CANCELLED.into())
        );
        assert!(registry.state.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn cancellation_before_registration_never_polls_the_operation() {
        let registry = Registry::default();
        registry
            .cancel(RequestKind::Dictionary, Some("early"))
            .unwrap();
        assert!(
            matches!(registry.begin(RequestKind::Dictionary, Some("early")), Err(error) if error == CANCELLED)
        );
        assert_eq!(
            registry
                .begin(RequestKind::Dictionary, Some("other"))
                .unwrap()
                .run(async { Ok(7) })
                .await,
            Ok(7)
        );
    }

    #[tokio::test]
    async fn request_kind_is_part_of_the_cancellation_key() {
        let registry = Registry::default();
        let translate = registry
            .begin(RequestKind::Translate, Some("same"))
            .unwrap();
        let chat = registry.begin(RequestKind::Chat, Some("same")).unwrap();
        let dictionary = registry
            .begin(RequestKind::Dictionary, Some("same"))
            .unwrap();
        registry.cancel(RequestKind::Chat, Some("same")).unwrap();
        assert_eq!(chat.run(async { Ok(()) }).await, Err(CANCELLED.into()));
        assert_eq!(translate.run(async { Ok(()) }).await, Ok(()));
        assert_eq!(dictionary.run(async { Ok(()) }).await, Ok(()));
    }

    #[tokio::test]
    async fn legacy_abort_still_cancels_only_active_requests_of_that_kind() {
        let registry = Registry::default();
        let first = registry
            .begin(RequestKind::Translate, Some("first"))
            .unwrap();
        let legacy = registry.begin(RequestKind::Translate, None).unwrap();
        let other = registry.begin(RequestKind::Chat, Some("other")).unwrap();
        registry.cancel(RequestKind::Translate, None).unwrap();
        assert_eq!(first.run(async { Ok(()) }).await, Err(CANCELLED.into()));
        assert_eq!(legacy.run(async { Ok(()) }).await, Err(CANCELLED.into()));
        assert_eq!(other.run(async { Ok(()) }).await, Ok(()));
        assert_eq!(
            registry
                .begin(RequestKind::Translate, Some("later"))
                .unwrap()
                .run(async { Ok(()) })
                .await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn duplicate_id_does_not_replace_the_original_abort_handle() {
        let registry = Registry::default();
        let original = registry
            .begin(RequestKind::Translate, Some("duplicate"))
            .unwrap();
        assert!(registry
            .begin(RequestKind::Translate, Some("duplicate"))
            .is_err());
        registry
            .cancel(RequestKind::Translate, Some("duplicate"))
            .unwrap();
        assert!(registry
            .begin(RequestKind::Translate, Some("duplicate"))
            .is_err());
        assert_eq!(original.run(async { Ok(()) }).await, Err(CANCELLED.into()));
        assert!(registry.state.lock().unwrap().active.is_empty());
    }

    #[test]
    fn dropped_operation_removes_its_handle() {
        let registry = Registry::default();
        let request = registry
            .begin(RequestKind::Dictionary, Some("drop"))
            .unwrap();
        drop(request.run(std::future::pending::<Result<(), String>>()));
        assert!(registry.state.lock().unwrap().active.is_empty());
        assert!(registry
            .begin(RequestKind::Dictionary, Some("drop"))
            .is_ok());
    }

    #[test]
    fn pending_cancellations_are_bounded_expiring_and_validated() {
        let registry = Registry::default();
        for n in 0..MAX_PENDING + 10 {
            registry
                .cancel(RequestKind::Chat, Some(&format!("pending-{n}")))
                .unwrap();
        }
        assert_eq!(registry.state.lock().unwrap().pending.len(), MAX_PENDING);
        assert!(registry.cancel(RequestKind::Chat, Some("")).is_err());
        assert!(registry
            .begin(RequestKind::Chat, Some(&"x".repeat(129)))
            .is_err());
        registry
            .state
            .lock()
            .unwrap()
            .pending
            .values_mut()
            .for_each(|time| *time = Instant::now() - PENDING_TTL);
        registry.cancel(RequestKind::Chat, Some("new")).unwrap();
        assert_eq!(registry.state.lock().unwrap().pending.len(), 1);
    }
}
