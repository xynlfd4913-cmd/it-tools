(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReferenceBindings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const roleLabels = { product: "商品", person: "人物", scene: "场景", object: "物体", reference: "参考目标" };
  const aliases = {
    商品: ["商品原图", "产品", "产品图"],
    人物: ["人物图", "达人", "达人图", "人物持品图"],
    场景: ["场景图", "商品场景图"],
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const urls = (value) => (Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/)).map((item) => String(item).trim()).filter(Boolean);
  const isStrict = (value) => ["product-interaction-scene-strict-v2", "product-person-scene-strict"].includes(value);

  function additionalReferences(value) {
    if (value != null && !Array.isArray(value)) throw new Error("参考目标必须是列表");
    if (list(value).length > 6) throw new Error("自定义参考目标最多 6 个");
    return list(value).map((item, index) => ({
      id: String(item?.id || `extra-${index + 1}`),
      name: String(item?.name || "").trim(),
      role: String(item?.role || "object"),
      target: String(item?.target || "").trim(),
      url: String(item?.url || "").trim(),
      custom: true,
    }));
  }

  function videoReferences(input) {
    if (input.generation_type === "text-to-video") return [];
    const base = isStrict(input.reference_policy) ? [
      { id: "product", name: "商品", role: "product", url: input.product_image_url, target: "商品" },
      { id: "person", name: "人物", role: "person", url: input.person_image_url, target: "人物及其持握关系" },
      { id: "scene", name: "场景", role: "scene", url: urls(input.scene_image_urls)[0], target: "场景、机位与商品摆位" },
    ] : urls(input.image_urls).map((url, index) => ({ id: `image-${index + 1}`, name: `图片${index + 1}`, role: "reference", url }));
    return position([...base, ...additionalReferences(input.additional_references)]);
  }

  function imageReferences(productUrl, extra) {
    return position([
      { id: "product", name: "商品", role: "product", target: "商品", url: productUrl },
      ...additionalReferences(extra),
    ]);
  }

  function position(references) {
    return references.map((reference, index) => ({ ...reference, target: String(reference.target || "").trim(), url: String(reference.url || "").trim(), position: index + 1 }));
  }

  function referenceAliases(reference) {
    return [reference.name, ...(aliases[reference.name] || []), `图片${reference.position}`, `图${reference.position}`];
  }

  function validateReferences(references) {
    if (references.length > 9) throw new Error("参考图片最多 9 张");
    const usedNames = new Map();
    const usedIds = new Set();
    for (const reference of references) {
      if (!/^[\p{L}\p{N}_ -]{1,24}$/u.test(reference.name)) throw new Error("参考目标名称需为 1–24 个文字、数字、空格或下划线");
      if (!(reference.role in roleLabels)) throw new Error(`参考目标「${reference.name}」类型无效`);
      if (reference.target.length > 200) throw new Error(`参考目标「${reference.name}」的目标描述最多 200 字`);
      if (!reference.url) throw new Error(`参考目标「${reference.name}」缺少图片`);
      if (usedIds.has(reference.id)) throw new Error(`参考目标编号重复：${reference.id}`);
      usedIds.add(reference.id);
      for (const alias of referenceAliases(reference)) {
        if (usedNames.has(alias) && usedNames.get(alias) !== reference.id) throw new Error(`参考目标名称冲突：${alias}`);
        usedNames.set(alias, reference.id);
      }
    }
    // Built-in names stay reserved so custom targets cannot silently change their meaning.
    for (const reference of references) {
      if (reference.custom && Object.entries(aliases).some(([name, values]) => [name, ...values].includes(reference.name))) {
        throw new Error(`「${reference.name}」为固定引用名称，请给自定义目标使用独立名称`);
      }
    }
    return references;
  }

  function compilePrompt(value, references) {
    const byAlias = new Map();
    references.forEach((reference) => referenceAliases(reference).forEach((alias) => byAlias.set(alias, reference)));
    const names = [...byAlias.keys()].sort((a, b) => b.length - a.length);
    const mentions = [];
    const resolve = (name) => {
      const reference = byAlias.get(name);
      if (!reference || !reference.url) throw new Error(`@引用「${name}」没有对应参考图片，请添加或选择该参考目标`);
      mentions.push({ name, position: reference.position, id: reference.id });
      return /^图(?:片)?\d+$/.test(name)
        ? `图片${reference.position}`
        : `图片${reference.position}中的${reference.target || roleLabels[reference.role]}`;
    };
    const text = String(value || "").replace(/(?<![\w@])@(\{([^{}\r\n]+)\}|[^\s@{}，。；：！？、,.;:!?()（）]+)/gu, (match, token, braced) => {
      if (braced != null) return resolve(braced.trim());
      const numeric = token.match(/^图(?:片)?\s*(\d+)/);
      if (numeric) return resolve(`图片${Number(numeric[1])}`) + token.slice(numeric[0].length);
      const name = names.find((alias) => token.startsWith(alias));
      if (!name) throw new Error(`@引用「${token}」未绑定，请从参考目标列表选择`);
      return resolve(name) + token.slice(name.length);
    });
    if (/@\{/.test(text)) throw new Error("@引用未闭合，请重新选择参考目标");
    if (/(^|[^\w])@(?=\s|$)/u.test(text)) throw new Error("@引用未选择目标，请从参考目标列表选择");
    return { text, mentions };
  }

  function bindingText(references) {
    if (!references.length) return "";
    return "【参考目标对应关系】" + references.map((reference) => `图片${reference.position}：${reference.name}（${roleLabels[reference.role]}${reference.target ? `；只参考${reference.target}` : ""}）`).join("；") + "。自定义参考只约束指定目标，不得覆盖商品原图或其他已绑定目标。";
  }

  return { roleLabels, videoReferences, imageReferences, validateReferences, compilePrompt, bindingText };
});
