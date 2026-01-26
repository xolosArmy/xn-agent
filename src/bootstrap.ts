import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const parseEnvBool = (value?: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
};

const setEnvBool = (key: string, value: boolean) => {
  process.env[key] = value ? "true" : "false";
};

const applyEmbeddingDefaults = () => {
  const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
  const useOpenAI = parseEnvBool(process.env.USE_OPENAI_EMBEDDING);
  const useOllama = parseEnvBool(process.env.USE_OLLAMA_EMBEDDING);

  if (useOllama !== false) {
    setEnvBool("USE_OLLAMA_EMBEDDING", false);
  }

  if (hasOpenAIKey && useOpenAI !== true) {
    setEnvBool("USE_OPENAI_EMBEDDING", true);
  }

  if (
    parseEnvBool(process.env.USE_OPENAI_EMBEDDING) === true &&
    !process.env.OPENAI_EMBEDDING_MODEL
  ) {
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-large";
  }
};

const applyLlamaDisableDefaults = () => {
  process.env.OLLAMA_MODEL = "disabled";
  process.env.OLLAMA_EMBEDDING_MODEL = "disabled";
  process.env.OLLAMA_SERVER_URL = "http://127.0.0.1:11435";
  process.env.LLAMALOCAL_PATH = "disabled";
};

const logStartupBanner = () => {
  console.info("[startup] provider config:", {
    OPENAI_API_KEY_PRESENT: Boolean(process.env.OPENAI_API_KEY),
    USE_OPENAI_EMBEDDING: process.env.USE_OPENAI_EMBEDDING,
    USE_OLLAMA_EMBEDDING: process.env.USE_OLLAMA_EMBEDDING,
    OLLAMA_MODEL: process.env.OLLAMA_MODEL,
    OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL,
    OLLAMA_SERVER_URL: process.env.OLLAMA_SERVER_URL,
    LLAMALOCAL_PATH: process.env.LLAMALOCAL_PATH,
  });
};

applyLlamaDisableDefaults();
applyEmbeddingDefaults();
logStartupBanner();

import("./index.ts").catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
