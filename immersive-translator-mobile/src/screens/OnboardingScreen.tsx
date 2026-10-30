import { useState } from "react";
import { actions, flushPersist } from "../store";
import { useNav } from "../ui/nav";
export default function OnboardingScreen() {
 const nav=useNav(); const [goal,setGoal]=useState("读外刊与原版书"); const [error,setError]=useState("");
 async function begin(){try{actions.setSettings({goal});actions.setOnboarded();actions.setTab("today");await flushPersist();nav.popAll();}catch(e){setError(String(e));}}
 return <main className="learning-onboarding"><span className="learning-tag">读到 · 记住 · 用出来</span><h1>让读过的英语，<br/>成为自己的表达。</h1><p>从一篇短文开始，留下想用的词，再试着说一句。</p><fieldset><legend>你最想把英语用在哪里？</legend>{["读外刊与原版书","职场沟通","日常交流"].map(label=><label className="learning-row" key={label}><input type="radio" name="goal" checked={goal===label} onChange={()=>setGoal(label)}/>{label}</label>)}</fieldset><div className="learning-card"><b>先体验，再决定是否登录</b><p>样文阅读、收藏和复习都可以本地使用。需要云端处理时再登录。</p></div><button className="btn" onClick={()=>void begin()}>开始我的第一篇阅读</button>{error&&<p role="alert">{error}</p>}</main>;
}
