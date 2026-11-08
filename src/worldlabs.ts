export type WorldPrompt =
  | { type: "text"; text_prompt: string }
  | { type: "image"; image_prompt: ImagePrompt; text_prompt?: string }
  | { type: "panorama"; image_asset_id: string }
  | { type: "video"; video_asset_id: string };

export type ImagePrompt =
  | {
      source: "uri";
      uri: string;
    }
  | {
      source: "media_asset";
      media_asset_id: string;
    };

export interface GenerationRequest {
  display_name: string;
  model: string;
  world_prompt: WorldPrompt;
}

export interface OperationResponse {
  operation_id: string;
  done: boolean;
  metadata?: {
    world_id?: string;
  };
  response?: {
    world_id?: string;
    assets: {
      splats: {
        spz_urls: {
          full?: string;
          full_res?: string;
          [key: string]: string | undefined;
        };
      };
    };
  };
  error?: any;
}

export class WorldLabsService {
  private apiKey: string;
  private baseUrl = "https://api.worldlabs.ai/marble/v1";
  private static readonly pollIntervalMs = 5000;
  private static readonly pollTimeoutMs = 60 * 60 * 1000;

  constructor(apiKey = "") {
    this.apiKey = apiKey;
  }

  async generateWorld(prompt: string): Promise<string> {
    return this.submitGeneration({
      type: "text",
      text_prompt: prompt,
    });
  }

  async generateWorldFromImageUrl(
    imageUrl: string,
    textPrompt?: string,
  ): Promise<string> {
    return this.submitGeneration({
      type: "image",
      image_prompt: {
        source: "uri",
        uri: imageUrl,
      },
      text_prompt: textPrompt,
    });
  }

  private async submitGeneration(worldPrompt: WorldPrompt): Promise<string> {
    const response = await fetch(`${this.baseUrl}/worlds:generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "WLT-Api-Key": this.apiKey,
      },
      body: JSON.stringify({
        display_name: `Generated World - ${new Date().toLocaleTimeString()}`,
        model: "marble-1.1",
        world_prompt: worldPrompt,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Generation failed: ${await this.readErrorBody(response)}`,
      );
    }

    const data = await response.json();
    const operationId = data.operation_id;

    return this.pollOperation(operationId);
  }

  private async fetchWorldImageUrl(worldId: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/worlds/${worldId}`, {
      headers: {
        "WLT-Api-Key": this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(
        `World fetch failed: ${await this.readErrorBody(response)}`,
      );
    }

    const data: any = await response.json();
    const imageUrl =
      data?.imagery?.pano_url ??
      data?.assets?.splats?.spz_urls?.full_res ??
      data?.assets?.splats?.spz_urls?.full;

    if (!imageUrl) {
      throw new Error("World fetch complete but no image URL found");
    }

    return imageUrl;
  }

  private async pollOperation(operationId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const interval = setInterval(async () => {
        try {
          if (Date.now() - startedAt >= WorldLabsService.pollTimeoutMs) {
            clearInterval(interval);
            reject(new Error("Generation timed out after 60 minutes"));
            return;
          }

          const response = await fetch(
            `${this.baseUrl}/operations/${operationId}`,
            {
              headers: {
                "WLT-Api-Key": this.apiKey,
              },
            },
          );

          if (!response.ok) {
            clearInterval(interval);
            reject(
              new Error(
                `Polling failed: ${await this.readErrorBody(response)}`,
              ),
            );
            return;
          }

          const data: OperationResponse = await response.json();

          if (data.done) {
            clearInterval(interval);
            if (data.error) {
              reject(
                new Error(
                  `Operation finished with error: ${JSON.stringify(data.error)}`,
                ),
              );
            } else {
              const worldId =
                data.metadata?.world_id ?? data.response?.world_id;
              const splatUrl =
                data.response?.assets?.splats?.spz_urls?.full_res ??
                data.response?.assets?.splats?.spz_urls?.full;

              if (worldId) {
                resolve(await this.fetchWorldImageUrl(worldId));
              } else if (splatUrl) {
                resolve(splatUrl);
              } else {
                reject(
                  new Error(
                    "Operation complete but no world ID or splat URL found",
                  ),
                );
              }
            }
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, WorldLabsService.pollIntervalMs);
    });
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return response.statusText || "Unknown error";
    }
  }
}
