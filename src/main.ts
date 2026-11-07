import "./style.css";
import "./script.ts";
import { loadWorld } from "./script";
import { WorldLabsService } from "./worldlabs";

const app = document.querySelector<HTMLDivElement>("#app")!;

// Initial Landing UI
app.innerHTML = `
  <div class="loader-container">
    <div class="loader"></div>
    <p>Loading...</p>
  </div>
`;

setTimeout(() => {
  renderMainUI();
}, 1000);

function renderMainUI() {
  // app.innerHTML = `
  //   <section class="hero-section" id="hero">
  //     <h1>WorldLab-Int</h1>
  //     <p>Paste an image URL to generate an immersive 3D world with the World Labs Marble API.</p>
  //   </section>

  //   <div class="controls-panel" id="controls">
  //     <div class="input-group">
  //       <label for="api-key">Marble API Key</label>
  //       <input type="password" id="api-key" placeholder="Enter your WLT-Api-Key..." />
  //     </div>

  //     <div class="input-group">
  //       <label for="image-url">Source Image URL</label>
  //       <input type="url" id="image-url" placeholder="https://example.com/image.png" />
  //     </div>

  //     <button class="btn-generate" id="generate-btn" disabled>
  //       <span>Enter</span>
  //     </button>
  //     <div class="status-text" id="status">Ready to generate</div>
  //   </div>
  // `

  const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement | null;
  const apiKeyInput = document.getElementById("api-key") as HTMLInputElement | null;
  const imageInput = document.getElementById("image-url") as HTMLInputElement | null;
  const statusText = document.getElementById("status");
  if (!generateBtn || !apiKeyInput || !imageInput || !statusText) return;

  const updateGenerateState = () => {
    generateBtn.disabled = imageInput.value.trim().length === 0;
  };

  // imageInput.addEventListener('input', updateGenerateState)
  // updateGenerateState()

  // imageInput.focus()
  // document.addEventListener("touchstart", handleTouchStart, { passive: false });
  generateBtn.addEventListener("click", async () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
      statusText.innerText = "Please enter an API key";
      return;
    }

    try {
      generateBtn.disabled = true;
      generateBtn.innerText = "Initializing...";

      const service = new WorldLabsService(apiKey);
      const imageUrl = imageInput.value.trim();
      if (!imageUrl) {
        statusText.innerText = "Please enter an image URL";
        generateBtn.disabled = false;
        return;
      }

      statusText.innerText = "Generating world from image URL...";
      const splatUrl = await service.generateWorldFromImageUrl(imageUrl);

      statusText.innerText = "Generation complete! Loading world...";
      await loadWorld(splatUrl);

      statusText.innerText = "World loaded successfully";
    } catch (error: any) {
      console.error(error);
      statusText.innerText = `Error: ${error.message}`;
    } finally {
      generateBtn.disabled = false;
      updateGenerateState();
      generateBtn.innerText = "Enter";
    }
  });
}
