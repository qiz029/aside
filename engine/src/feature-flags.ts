/** Public decisions only: never expose targeting rules or account attributes. */
export interface VoiceFeatures {
  liveEnabled: boolean;
  geminiEligible: boolean;
  preferredProvider: "openai" | "gemini";
  /** Providers implemented by this release, independent of rollout eligibility. */
  availableProviders: ("openai" | "gemini")[];
  provider: "openai" | "gemini";
}

export const defaultVoiceFeatures = (): VoiceFeatures => ({
  liveEnabled: true,
  geminiEligible: false,
  preferredProvider: "openai",
  availableProviders: ["openai"],
  provider: "openai",
});
