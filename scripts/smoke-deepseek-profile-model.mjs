import {
  DeepSeekJsonModelProvider,
  parseDeepSeekGatewayConfig,
} from "../packages/ai/dist/index.js";

const provider = new DeepSeekJsonModelProvider({
  ...parseDeepSeekGatewayConfig(),
  maxTokens: 512,
});
const result = await provider.generateJson({
  systemPrompt: "Return json only. This is a synthetic connectivity test.",
  userPrompt: "Return a JSON object with status set to available.",
});
const status =
  result.json !== null &&
  typeof result.json === "object" &&
  "status" in result.json &&
  result.json.status === "available";
if (!status) throw new Error("DeepSeek connectivity response did not match the safe probe.");
console.log(
  JSON.stringify({
    configured: true,
    jsonReceived: true,
    model: result.model,
    totalTokens: result.usage.totalTokens,
  }),
);
