// 关于页「隐私政策」卡：默认收起摘要，点开看全文（Store 政策 10.5.1 要求应用内可访问隐私政策）。
import { useState } from "react";
import {
  PRIVACY_CONTACT_TEXT,
  PRIVACY_POLICY_INTRO,
  PRIVACY_POLICY_UPDATED_AT,
  PRIVACY_SECTIONS,
} from "./privacyPolicy";

export function PrivacyPolicyCard() {
  const [open, setOpen] = useState(false);
  return (
    <section className="group-card about-privacy">
      <div className="settings-section-heading">
        <div>
          <h3>隐私政策</h3>
          <p>数据怎么收集、怎么使用（更新于 {PRIVACY_POLICY_UPDATED_AT}）</p>
        </div>
      </div>
      {open && (
        <div className="about-privacy-body">
          <p>{PRIVACY_POLICY_INTRO}</p>
          {PRIVACY_SECTIONS.map((s) => (
            <p key={s.title}>
              <strong>{s.title}：</strong>
              {s.body}
            </p>
          ))}
          <p>{PRIVACY_CONTACT_TEXT}</p>
        </div>
      )}
      <div className="about-release-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}>
          {open ? "收起" : "查看完整政策"}
        </button>
      </div>
    </section>
  );
}
