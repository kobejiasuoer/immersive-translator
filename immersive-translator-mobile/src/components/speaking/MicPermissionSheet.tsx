/**
 * 麦克风授权抽屉（speaking-parity · 原型 SHEETS.micPermission，html:2656-2661）：
 * 底部抽屉（grabber + 右上 ×，复用 ReadingDrawer 基座）＝ voice-soft 靛蓝图标块 +
 * 「允许使用麦克风？」+ 说明 + hairline 分隔 + 「🔊 暂不开启…」行 + voice 主按钮 +
 * ghost「先听和读，暂不开启」+ 文字链「改用文字回答」。
 * 点「允许」后仍走练习页既有的 startRecord 真实录音链路（登录门/设备校验不变）。
 */
import { ReadingDrawer } from "../reading/Drawer";
import { Icon } from "../../ui/icons";

export function MicPermissionSheet({
  open,
  onClose,
  onAllow,
  onText,
}: {
  open: boolean;
  onClose: () => void;
  /** 「允许，并开始录音」：关闭抽屉并进入既有录音流程。 */
  onAllow: () => void;
  /** 「改用文字回答」：关闭抽屉并切到文字草稿。 */
  onText: () => void;
}) {
  return (
    <ReadingDrawer open={open} onClose={onClose} label="麦克风使用说明">
      <div className="sp-sheet-head">
        <div className="v2-sp-permission-icon">
          <Icon name="mic" size={22} />
        </div>
        <h3>允许使用麦克风？</h3>
        <p className="sp-sheet-copy">你的声音用于这次口语练习。说完可以修改识别结果，再决定是否发送。</p>
      </div>
      <div className="sp-sheet-body">
        <div className="v2-sp-permission-option">
          <Icon name="speaker" size={15} />
          <span>暂不开启，也可以听示范、看提示或输入回答。</span>
        </div>
        <button className="btn voice" onClick={onAllow}>
          <Icon name="mic" size={15} />
          允许，并开始录音
        </button>
        <button className="btn-ghost" style={{ marginTop: 10 }} onClick={onClose}>
          先听和读，暂不开启
        </button>
        <button className="v2-sp-text-action" onClick={onText}>
          改用文字回答
        </button>
      </div>
    </ReadingDrawer>
  );
}
