import { describe, expect, it } from "vitest";
import { splitParagraphs, splitSentences } from "./sentenceSplit";

describe("splitSentences", () => {
  it("按句号切分并保留标点", () => {
    expect(splitSentences("One. Two. Three.")).toEqual(["One.", "Two.", "Three."]);
  });

  it("不切小数点与网址类数字", () => {
    expect(splitSentences("It costs 3.14 dollars. Version 2.0 shipped.")).toEqual([
      "It costs 3.14 dollars.",
      "Version 2.0 shipped.",
    ]);
  });

  it("不切常见缩写", () => {
    expect(splitSentences("Mr. Smith met Dr. Brown. They talked.")).toEqual([
      "Mr. Smith met Dr. Brown.",
      "They talked.",
    ]);
    expect(splitSentences("Compare e.g. apples and pears. Fruit is good.")).toEqual([
      "Compare e.g. apples and pears.",
      "Fruit is good.",
    ]);
  });

  it.each(["Mr.", "Mrs.", "Ms.", "Dr.", "Prof."])("称谓 %s 与后续姓名保持在一句", (title) => {
    expect(splitSentences(`${title} Smith met Dr. He at 3.15 p.m. They talked.`)).toEqual([
      `${title} Smith met Dr. He at 3.15 p.m.`,
      "They talked.",
    ]);
  });

  it("保留姓名中的连续首字母与带点缩写", () => {
    expect(splitSentences("J. R. R. Tolkien met J.R.R. Smith and A. B. Jones. They talked.")).toEqual([
      "J. R. R. Tolkien met J.R.R. Smith and A. B. Jones.",
      "They talked.",
    ]);
  });

  it("U.S.、U.K. 和大写机构名称不被拆散", () => {
    expect(splitSentences("The U.S. Department met the U.K. Prime Minister and an F.B.I. Director. Talks continued.")).toEqual([
      "The U.S. Department met the U.K. Prime Minister and an F.B.I. Director.",
      "Talks continued.",
    ]);
  });

  it.each(["U.S.", "U.K.", "F.B.I.", "N.A.S.A."])("%s 用作句末时仍切出后续新句", (abbreviation) => {
    expect(splitSentences(`They returned to the ${abbreviation} It was late. This was expected.`)).toEqual([
      `They returned to the ${abbreviation}`,
      "It was late.",
      "This was expected.",
    ]);
  });

  it("缩写后的人称所属与时间短语可以开始新句", () => {
    expect(splitSentences("He works in the U.S. His team is based in the U.K. In June it moved.")).toEqual([
      "He works in the U.S.",
      "His team is based in the U.K.",
      "In June it moved.",
    ]);
  });

  it("可以在句末出现的缩写不吞掉后续大写句子", () => {
    expect(splitSentences("Bring paper, pens, etc. Keep them dry. I work at Acme Inc. Revenue is growing.")).toEqual([
      "Bring paper, pens, etc.",
      "Keep them dry.",
      "I work at Acme Inc.",
      "Revenue is growing.",
    ]);
  });

  it("e.g. 和 i.e. 后的大写示例仍属于原句", () => {
    expect(splitSentences("Try e.g. London or i.e. New York. Then decide.")).toEqual([
      "Try e.g. London or i.e. New York.",
      "Then decide.",
    ]);
  });

  it("保留小数、网址与邮件内部的句点", () => {
    expect(splitSentences("Visit https://energy.gov or write to a.b@example.com. The price is $3.14, not $2.0.")).toEqual([
      "Visit https://energy.gov or write to a.b@example.com.",
      "The price is $3.14, not $2.0.",
    ]);
  });

  it("英文引号与括号中的句末标点保留在上一句", () => {
    expect(splitSentences('He said “We live in the U.S.” Then she left. (Really!) Yes.')).toEqual([
      "He said “We live in the U.S.”",
      "Then she left.",
      "(Really!)",
      "Yes.",
    ]);
    expect(splitSentences('“Stop!” she said. “Go.” Next.')).toEqual([
      "“Stop!” she said.",
      "“Go.”",
      "Next.",
    ]);
  });

  it("Energy.gov 新闻中的 U.S. Department 不生成残句", () => {
    const first = "WASHINGTON— The U.S. Department of Energy (DOE) today announced a $237 million funding opportunity to boost American manufacturing and strengthen supply chains for critical electric grid components.";
    const second = "The investment is expected to deliver an estimated $125 million in annual utility savings and keep an estimated $50 million per year in the U.S. economy that would otherwise go to foreign suppliers.";
    expect(splitSentences(`${first} ${second}`)).toEqual([first, second]);
  });

  it("Energy.gov 新闻中的 said U.S. Secretary 与说话人保持完整", () => {
    const first = "“President Trump is bringing American industry and manufacturing back home, including the critical equipment and components needed to power our nation,” said U.S. Secretary of Energy Chris Wright.";
    const second = "“The Energy Department is investing in American-made technologies and modernizing our grid to reduce reliance on foreign suppliers and deliver affordable, reliable, electricity.”";
    expect(splitSentences(`${first} ${second}`)).toEqual([first, second]);
  });

  it("问号叹号与省略号收句", () => {
    expect(splitSentences("Really?! Yes... Then what? Next.")).toEqual([
      "Really?!",
      "Yes...",
      "Then what?",
      "Next.",
    ]);
  });

  it("小写开头的后续不算新句", () => {
    expect(splitSentences("He said \"hello. then left. quickly.")).toEqual([
      'He said "hello. then left. quickly.',
    ]);
  });

  it("折叠多余空白", () => {
    expect(splitSentences("A  sentence\n  with  whitespace. Another.")).toEqual([
      "A sentence with whitespace.",
      "Another.",
    ]);
  });

  it("末尾无标点的尾巴成句", () => {
    expect(splitSentences("First. Second without dot")).toEqual([
      "First.",
      "Second without dot",
    ]);
  });
});

describe("splitParagraphs", () => {
  it("按空行分段并编号", () => {
    const result = splitParagraphs("Para one. Two sentences here.\n\nSecond paragraph.");
    expect(result).toHaveLength(2);
    expect(result[0].paragraphIdx).toBe(0);
    expect(result[0].sentences).toEqual(["Para one.", "Two sentences here."]);
    expect(result[1].paragraphIdx).toBe(1);
    expect(result[1].sentences).toEqual(["Second paragraph."]);
  });

  it("单换行也分段", () => {
    const result = splitParagraphs("Line one. More.\nLine two.");
    expect(result).toHaveLength(2);
  });

  it("跳过纯空白段", () => {
    const result = splitParagraphs("Only.  \n\n   \n\nReal.");
    expect(result).toHaveLength(2);
  });

  it("中文段落按句读不成句时整段为一句", () => {
    const result = splitParagraphs("这是一段没有英文句号的中文");
    expect(result[0].sentences).toEqual(["这是一段没有英文句号的中文"]);
  });
});
