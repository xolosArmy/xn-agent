
import {
  Character,
  ModelProviderName,
  defaultCharacter,
  settings,
  validateCharacterConfig,
} from "@elizaos/core";
import fs from "fs";
import path from "path";
import yargs from "yargs";

export function normalizeArgv(args: string[]) {
  return args.filter((arg) => arg !== "--");
}

export function parseArguments(): {
  character?: string;
  characters?: string | string[];
} {
  try {
    const rawArgs = process.argv.slice(2);
    const normalizedArgs = normalizeArgv(rawArgs);
    console.info("CLI args raw:", rawArgs);
    console.info("CLI args normalized:", normalizedArgs);

    return yargs(normalizedArgs)
      .option("character", {
        type: "string",
        description: "Path to the character JSON file",
      })
      .option("characters", {
        type: "string",
        description: "Comma separated list of paths to character JSON files",
      })
      .array("characters")
      .parseSync();
  } catch (error) {
    console.error("Error parsing arguments:", error);
    return {};
  }
}

export async function loadCharacters(
  charactersArg: string | string[]
): Promise<Character[]> {
  const characterPaths = resolveCharacterPaths(charactersArg);

  const loadedCharacters = [];

  if (characterPaths?.length > 0) {
    for (const path of characterPaths) {
      try {
        const character = JSON.parse(fs.readFileSync(path, "utf8"));
        const mergedCharacter: Character = {
          ...defaultCharacter,
          ...character,
          settings: {
            ...defaultCharacter.settings,
            ...character.settings,
            secrets: {
              ...(defaultCharacter.settings?.secrets ?? {}),
              ...(character.settings?.secrets ?? {}),
            },
            voice: {
              ...(defaultCharacter.settings?.voice ?? {}),
              ...(character.settings?.voice ?? {}),
            },
          },
        };

        validateCharacterConfig(mergedCharacter);

        loadedCharacters.push(mergedCharacter);
      } catch (e) {
        console.error(`Error loading character from ${path}: ${e}`);
        // don't continue to load if a specified file is not found
        process.exit(1);
      }
    }
  }

  return loadedCharacters;
}

export function resolveCharacterPaths(
  charactersArg?: string | string[]
): string[] {
  if (!charactersArg) {
    return [];
  }

  const rawArgs = Array.isArray(charactersArg) ? charactersArg : [charactersArg];
  const parts = rawArgs.flatMap((arg) => arg.split(",")).filter(Boolean);

  return parts.map((filePath) => {
    if (path.basename(filePath) === filePath) {
      filePath = "../characters/" + filePath;
    }
    return path.resolve(process.cwd(), filePath.trim());
  });
}

export function resolveModelProvider(character: Character): ModelProviderName {
  const envProviderRaw = process.env.MODEL_PROVIDER?.trim().toLowerCase();
  if (!envProviderRaw) {
    return character.modelProvider;
  }

  const providers = new Set(Object.values(ModelProviderName));
  if (providers.has(envProviderRaw as ModelProviderName)) {
    return envProviderRaw as ModelProviderName;
  }

  console.warn(
    `MODEL_PROVIDER="${process.env.MODEL_PROVIDER}" is not recognized; using character modelProvider "${character.modelProvider}".`
  );
  return character.modelProvider;
}

export function getTokenForProvider(
  provider: ModelProviderName,
  character: Character
) {
  switch (provider) {
    case ModelProviderName.OPENAI:
      return (
        character.settings?.secrets?.OPENAI_API_KEY || settings.OPENAI_API_KEY
      );
    case ModelProviderName.LLAMACLOUD:
      return (
        character.settings?.secrets?.LLAMACLOUD_API_KEY ||
        settings.LLAMACLOUD_API_KEY ||
        character.settings?.secrets?.TOGETHER_API_KEY ||
        settings.TOGETHER_API_KEY ||
        character.settings?.secrets?.XAI_API_KEY ||
        settings.XAI_API_KEY ||
        character.settings?.secrets?.OPENAI_API_KEY ||
        settings.OPENAI_API_KEY
      );
    case ModelProviderName.ANTHROPIC:
      return (
        character.settings?.secrets?.ANTHROPIC_API_KEY ||
        character.settings?.secrets?.CLAUDE_API_KEY ||
        settings.ANTHROPIC_API_KEY ||
        settings.CLAUDE_API_KEY
      );
    case ModelProviderName.REDPILL:
      return (
        character.settings?.secrets?.REDPILL_API_KEY || settings.REDPILL_API_KEY
      );
    case ModelProviderName.OPENROUTER:
      return (
        character.settings?.secrets?.OPENROUTER || settings.OPENROUTER_API_KEY
      );
    case ModelProviderName.GROK:
      return character.settings?.secrets?.GROK_API_KEY || settings.GROK_API_KEY;
    case ModelProviderName.HEURIST:
      return (
        character.settings?.secrets?.HEURIST_API_KEY || settings.HEURIST_API_KEY
      );
    case ModelProviderName.GROQ:
      return character.settings?.secrets?.GROQ_API_KEY || settings.GROQ_API_KEY;
  }
}
