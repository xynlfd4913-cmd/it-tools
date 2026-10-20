const test = require("node:test");
const assert = require("node:assert/strict");
const { videoReferences, imageReferences, validateReferences, compilePrompt } = require("../public/references");

const extras = [
  { id: "actor", name: "演员", role: "person", target: "左侧戴眼镜的人物", url: "https://cdn.example.com/person.png" },
  { id: "cup", name: "蓝色杯子", role: "object", target: "桌上的蓝色杯子", url: "https://cdn.example.com/cup.png" },
];
const videoInput = {
  generation_type: "reference-to-video",
  reference_policy: "product-interaction-scene-strict-v2",
  product_image_url: "asset://product",
  person_image_url: "asset://person",
  scene_image_urls: ["asset://scene"],
  additional_references: extras,
};

test("named person and object mentions follow the actual image order for each model", () => {
  const video = validateReferences(videoReferences(videoInput));
  const image = validateReferences(imageReferences("/assets/demo-product.png", extras));
  assert.equal(compilePrompt("@{演员} 拿起 @{蓝色杯子}", video).text, "图片4中的左侧戴眼镜的人物 拿起 图片5中的桌上的蓝色杯子");
  assert.equal(compilePrompt("@{演员} 拿起 @{蓝色杯子}", image).text, "图片2中的左侧戴眼镜的人物 拿起 图片3中的桌上的蓝色杯子");
  assert.equal(compilePrompt("@商品由@人物拿起，并在@场景展示@蓝色杯子。", video).mentions.length, 4);
  assert.doesNotMatch(compilePrompt("@图片1中的商品由@图片2中的人物拿起", video).text, /@/);
});

test("removing or reordering references recompiles named targets without stale numbers", () => {
  const reordered = videoReferences({ ...videoInput, additional_references: [...extras].reverse() });
  assert.match(compilePrompt("@{蓝色杯子}", reordered).text, /^图片4/);
  const removed = videoReferences({ ...videoInput, additional_references: [extras[1]] });
  assert.match(compilePrompt("@{蓝色杯子}", removed).text, /^图片4/);
  assert.throws(() => compilePrompt("@{演员}", removed), /没有对应参考图片/);
});

test("unbound, missing, malformed and out of range mentions fail before submission", () => {
  const references = videoReferences(videoInput);
  for (const prompt of ["@{未知人物}", "@图片12", "@{演员", "@未知物体", "请让 @ 展示商品"]) {
    assert.throws(() => compilePrompt(prompt, references), /引用/);
  }
  const missingPerson = videoReferences({ ...videoInput, person_image_url: "" });
  assert.throws(() => compilePrompt("@人物", missingPerson), /没有对应参考图片/);
  assert.throws(() => compilePrompt("@人物", []), /未绑定/);
  assert.equal(compilePrompt("请联系 user@example.com", references).text, "请联系 user@example.com");
});

test("duplicate and reserved names, missing images and too many targets are rejected", () => {
  const refs = (extra) => imageReferences("/assets/demo-product.png", extra);
  assert.throws(() => validateReferences(refs([...extras, { ...extras[1], id: "other" }])), /名称冲突/);
  assert.throws(() => validateReferences(refs([{ ...extras[0], name: "人物" }])), /固定引用名称/);
  assert.throws(() => validateReferences(refs([{ ...extras[0], url: "" }])), /缺少图片/);
  assert.throws(() => validateReferences(refs([{ ...extras[0], name: "bad@name" }])), /名称需为/);
  assert.throws(() => refs(Array(7).fill(extras[0])), /最多 6/);
});
