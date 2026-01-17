import { DirectClient } from "@elizaos/client-direct";
import {
  AgentRuntime,
  elizaLogger,
  settings,
  stringToUuid,
  ModelProviderName,
  type Character,
} from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { solanaPlugin } from "@elizaos/plugin-solana";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { initializeDbCache } from "./cache/index.ts";
import { character } from "./character.ts";
import { startChat } from "./chat/index.ts";
import { initializeClients } from "./clients/index.ts";
import {
  getTokenForProvider,
  loadCharacters,
  parseArguments,
  resolveCharacterPaths,
  resolveModelProvider,
} from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";
import { registerTriviaRoutes } from "./triviaRewards/routes.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;
let triviaRoutesRegistered = false;

const isEnvEnabled = (value?: string) => value === "1" || value === "true";

const extractOpenAIOutputText = (response: any): string => {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const content of item.content) {
        if (content?.type === "output_text" && typeof content?.text === "string") {
          return content.text;
        }
      }
    }
  }

  return "";
};

const runOpenAISmokeTest = async (token: string) => {
  if (!token) {
    elizaLogger.warn("OPENAI_API_KEY is not set; skipping OpenAI smoke test.");
    return;
  }

  try {
    const client = new OpenAI({
      apiKey: token,
      baseURL:
        process.env.OPENAI_BASE_URL ||
        settings.OPENAI_API_URL ||
        undefined,
    });
    const model = settings.SMALL_OPENAI_MODEL || "gpt-4o-mini";
    const response = await client.responses.create({
      model,
      input: "Say: ok",
    });
    const outputText = extractOpenAIOutputText(response).trim();
    elizaLogger.log(
      `OpenAI smoke test response: ${outputText || "[no text returned]"}`
    );
  } catch (error) {
    elizaLogger.warn(`OpenAI smoke test failed: ${String(error)}`);
  }
};

export function createAgent(
  character: Character,
  db: any,
  cache: any,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name,
  );

  nodePlugin ??= createNodePlugin();

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      nodePlugin,
      character.settings?.secrets?.WALLET_PUBLIC_KEY ? solanaPlugin : null,
    ].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

async function startAgent(character: Character, directClient: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;

    const token = getTokenForProvider(character.modelProvider, character);
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir);

    await db.init();

    if (!triviaRoutesRegistered) {
      registerTriviaRoutes({
        app: (directClient as any).app,
        dbAdapter: db,
        directClient,
      });
      triviaRoutesRegistered = true;
    }

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    if (
      runtime.modelProvider === ModelProviderName.OPENAI &&
      isEnvEnabled(process.env.OPENAI_SMOKE_TEST)
    ) {
      await runOpenAISmokeTest(token);
    }

    runtime.clients = await initializeClients(character, runtime);

    directClient.registerAgent(runtime);

    // report to console
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(`Error starting agent for character ${character.name}: ${String(error)}`);

    console.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
};

const startAgents = async () => {
  const directClient = new DirectClient();
  let serverPort = parseInt(settings.SERVER_PORT || "3000");
  const args = parseArguments();

  const charactersArg = args.character ?? args.characters;
  let characters = [character];

  console.info(`CLI charactersArg: ${JSON.stringify(charactersArg)}`);
  if (charactersArg) {
    const characterPaths = resolveCharacterPaths(charactersArg);
    console.info(
      `Resolved character paths: ${characterPaths.length ? characterPaths.join(", ") : "[none]"}`
    );
    characters = await loadCharacters(charactersArg);
  } else {
    console.info("No CLI character args provided; using default character.");
  }
  console.info(
    `Loaded characters: ${characters
      .map((loadedCharacter) => {
        const username = loadedCharacter.username || "unknown";
        return `${loadedCharacter.name} (${username})`;
      })
      .join(", ")}`
  );
  const resolvedCharacters = characters.map((loadedCharacter) => {
    const resolvedProvider = resolveModelProvider(loadedCharacter);
    if (resolvedProvider !== loadedCharacter.modelProvider) {
      elizaLogger.log(
        `MODEL_PROVIDER override: ${loadedCharacter.modelProvider} -> ${resolvedProvider}`
      );
      return { ...loadedCharacter, modelProvider: resolvedProvider };
    }
    return loadedCharacter;
  });

  try {
    for (const character of resolvedCharacters) {
      await startAgent(character, directClient as DirectClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents: " + String(error));
  }

  console.info("Finished starting agents; checking for available port.");
  while (!(await checkPortAvailable(serverPort))) {
    elizaLogger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }
  console.info(`Direct server will bind to PORT=${serverPort}`);

  // upload some agent functionality into directClient
  directClient.startAgent = async (character: Character) => {
    // wrap it so we don't have to inject directClient later
    return startAgent(character, directClient);
  };

  directClient.start(serverPort);
  console.info(`Direct server listening on PORT=${serverPort}`);

  if (serverPort !== parseInt(settings.SERVER_PORT || "3000")) {
    elizaLogger.log(`Server started on alternate port ${serverPort}`);
  }

  const isDaemonProcess = process.env.DAEMON_PROCESS === "true";
  if(!isDaemonProcess) {
    elizaLogger.log("Chat started. Type 'exit' to quit.");
    const chat = startChat(resolvedCharacters);
    chat();
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents: " + String(error));
  process.exit(1);
});
