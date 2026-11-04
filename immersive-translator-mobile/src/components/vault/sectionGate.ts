/** 书架入口指定复习域子页；普通 Tab 切换继续保留 VaultBody 自己的选择。 */
export type VaultSection = "today" | "words" | "notes";

const sectionEvent = "mobile-vault-section";
let pendingSection: VaultSection | null = null;

export function requestVaultSection(section: VaultSection): void {
  pendingSection = section;
  window.dispatchEvent(new Event(sectionEvent));
}

export function consumeVaultSection(): VaultSection | null {
  const section = pendingSection;
  pendingSection = null;
  return section;
}

export function subscribeVaultSection(listener: () => void): () => void {
  window.addEventListener(sectionEvent, listener);
  return () => window.removeEventListener(sectionEvent, listener);
}
