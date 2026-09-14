package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const tinyPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="

func TestComposeFinalPromptIncludesImageDescriptionAndUserPrompt(t *testing.T) {
	finalPrompt := composeFinalPrompt("red circle on white background", "add a heart")
	for _, expected := range []string{"red circle", "add a heart", "参考图片理解", "用户要求"} {
		if !strings.Contains(finalPrompt, expected) {
			t.Fatalf("final prompt missing %q: %s", expected, finalPrompt)
		}
	}
}

func TestGenerateWithImageDescribesThenGenerates(t *testing.T) {
	tempDir := t.TempDir()
	imagePath := filepath.Join(tempDir, "reference.png")
	imageBytes, err := base64.StdEncoding.DecodeString(tinyPNGBase64)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, imageBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	var sawResponses bool
	var sawGeneration bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		switch r.URL.Path {
		case "/responses":
			sawResponses = true
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("responses payload invalid: %v", err)
			}
			encoded, _ := json.Marshal(payload)
			if !strings.Contains(string(encoded), "data:image/png;base64,") {
				t.Fatalf("responses payload did not include image data URL: %s", encoded)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"output_text":"a red circle on a white background"}`))
		case "/images/generations":
			sawGeneration = true
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatalf("generation payload invalid: %v", err)
			}
			prompt, _ := payload["prompt"].(string)
			if !strings.Contains(prompt, "a red circle") || !strings.Contains(prompt, "add a small heart") {
				t.Fatalf("generation prompt did not combine vision and user text: %s", prompt)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"b64_json":"` + tinyPNGBase64 + `"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	t.Setenv("BASE_URL", server.URL)
	t.Setenv("RUIZHI_OPENAI_BASE_URL", server.URL)
	t.Setenv("OPENAI_BASE_URL", server.URL)
	t.Setenv("RUIZHI_API_KEY", "test-key")
	outPath := filepath.Join(tempDir, "out.png")
	if err := generate(generateOptions{
		Prompt:            "add a small heart",
		ImagePaths:        []string{imagePath},
		VisionModel:       defaultVisionModel,
		Out:               outPath,
		Model:             defaultModel,
		Size:              defaultSize,
		Quality:           defaultQuality,
		N:                 1,
		OutputFormat:      defaultOutputFormat,
		OutputCompression: -1,
		Force:             true,
	}); err != nil {
		t.Fatal(err)
	}
	if !sawResponses || !sawGeneration {
		t.Fatalf("expected both responses and generation calls, got responses=%v generation=%v", sawResponses, sawGeneration)
	}
	if _, err := os.Stat(outPath); err != nil {
		t.Fatalf("expected generated output file: %v", err)
	}
}

func TestWriteImagesPrintsRawMarkdownLine(t *testing.T) {
	tempDir := t.TempDir()
	outPath := filepath.Join(tempDir, "out.png")
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	originalStdout := os.Stdout
	os.Stdout = writePipe
	err = writeImages([]imageResponseItem{{B64JSON: tinyPNGBase64}}, []string{outPath}, true)
	_ = writePipe.Close()
	os.Stdout = originalStdout
	if err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(readPipe)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 || !strings.HasPrefix(strings.TrimSpace(lines[len(lines)-1]), "![generated image](") {
		t.Fatalf("expected final stdout line to be raw markdown image, got %q", string(output))
	}
}
