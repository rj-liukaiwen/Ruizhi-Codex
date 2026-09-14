package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBaseURL      = "https://gptauth.ruijie.com.cn/v1"
	defaultModel        = "gpt-image-2"
	defaultVisionModel  = "gpt-5.6-luna"
	defaultSize         = "auto"
	defaultQuality      = "medium"
	defaultOutputFormat = "png"
	defaultOutputPath   = "output/imagegen/output.png"
)

type imageResponse struct {
	Data []imageResponseItem `json:"data"`
}

type responsesAPIResponse struct {
	OutputText string                `json:"output_text"`
	Output     []responsesOutputItem `json:"output"`
}

type responsesOutputItem struct {
	Type    string                 `json:"type"`
	Role    string                 `json:"role"`
	Content []responsesContentItem `json:"content"`
}

type responsesContentItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type imageResponseItem struct {
	B64JSON string `json:"b64_json"`
	URL     string `json:"url"`
}

type batchJob struct {
	Prompt            string `json:"prompt"`
	Out               string `json:"out"`
	Model             string `json:"model"`
	Size              string `json:"size"`
	Quality           string `json:"quality"`
	N                 int    `json:"n"`
	OutputFormat      string `json:"output_format"`
	Background        string `json:"background"`
	Moderation        string `json:"moderation"`
	OutputCompression *int   `json:"output_compression"`
}

type generateOptions struct {
	Prompt            string
	PromptFile        string
	ImagePaths        []string
	VisionModel       string
	Out               string
	OutDir            string
	Model             string
	Size              string
	Quality           string
	N                 int
	OutputFormat      string
	Background        string
	Moderation        string
	OutputCompression int
	Force             bool
	DryRun            bool
}

type stringListFlag []string

func (f *stringListFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringListFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	*f = append(*f, value)
	return nil
}

type apiKeyCandidate struct {
	Key    string
	Source string
}

type apiError struct {
	StatusCode int
	Body       string
}

func (e *apiError) Error() string {
	return fmt.Sprintf("image API failed: HTTP %d: %s", e.StatusCode, strings.TrimSpace(e.Body))
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch args[0] {
	case "generate":
		return runGenerate(args[1:])
	case "generate-batch":
		return runGenerateBatch(args[1:])
	case "help", "-h", "--help":
		return usage()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func usage() error {
	fmt.Fprintln(os.Stderr, `Usage:
  ruizhi-imagegen generate --prompt "..." [--image reference.png] [--out output/imagegen/output.png]
  ruizhi-imagegen generate-batch --jobs jobs.jsonl --out-dir output/imagegen

Authentication:
  Reads RUIZHI_API_KEY/RUIJIE_UNIAPI_KEY/API_KEY first, then RuiZhi OAuth access_token/API key from auth.json, then OPENAI_API_KEY.`)
	return nil
}

func runGenerate(args []string) error {
	fs := flag.NewFlagSet("generate", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	opts := generateOptions{}
	fs.StringVar(&opts.Prompt, "prompt", "", "image prompt")
	fs.StringVar(&opts.PromptFile, "prompt-file", "", "path to prompt file")
	fs.Var((*stringListFlag)(&opts.ImagePaths), "image", "reference image path; may be repeated")
	fs.StringVar(&opts.VisionModel, "vision-model", envOr("RUIZHI_IMAGEGEN_VISION_MODEL", defaultVisionModel), "vision model used to describe reference images")
	fs.StringVar(&opts.Out, "out", defaultOutputPath, "output image path")
	fs.StringVar(&opts.OutDir, "out-dir", "", "output directory")
	fs.StringVar(&opts.Model, "model", defaultModel, "image model")
	fs.StringVar(&opts.Size, "size", defaultSize, "image size")
	fs.StringVar(&opts.Quality, "quality", defaultQuality, "quality: low, medium, high, auto")
	fs.IntVar(&opts.N, "n", 1, "number of images")
	fs.StringVar(&opts.OutputFormat, "output-format", defaultOutputFormat, "png, jpeg, or webp")
	fs.StringVar(&opts.Background, "background", "", "opaque or auto; transparent is not supported by gpt-image-2")
	fs.StringVar(&opts.Moderation, "moderation", "", "moderation mode")
	fs.IntVar(&opts.OutputCompression, "output-compression", -1, "output compression 0-100")
	fs.BoolVar(&opts.Force, "force", false, "overwrite existing files")
	fs.BoolVar(&opts.DryRun, "dry-run", false, "print request without calling the API")
	if err := fs.Parse(args); err != nil {
		return err
	}
	return generate(opts)
}

func runGenerateBatch(args []string) error {
	fs := flag.NewFlagSet("generate-batch", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	jobsPath := fs.String("jobs", "", "JSONL jobs file; each line is a prompt string or job object")
	outDir := fs.String("out-dir", "output/imagegen", "output directory")
	force := fs.Bool("force", false, "overwrite existing files")
	dryRun := fs.Bool("dry-run", false, "print requests without calling the API")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*jobsPath) == "" {
		return errors.New("missing --jobs")
	}
	jobs, err := readJobs(*jobsPath)
	if err != nil {
		return err
	}
	for idx, job := range jobs {
		opts := generateOptions{
			Prompt:            job.Prompt,
			Out:               job.Out,
			OutDir:            *outDir,
			Model:             valueOr(job.Model, defaultModel),
			Size:              valueOr(job.Size, defaultSize),
			Quality:           valueOr(job.Quality, defaultQuality),
			N:                 intOr(job.N, 1),
			OutputFormat:      valueOr(job.OutputFormat, defaultOutputFormat),
			Background:        job.Background,
			Moderation:        job.Moderation,
			OutputCompression: -1,
			Force:             *force,
			DryRun:            *dryRun,
		}
		if job.OutputCompression != nil {
			opts.OutputCompression = *job.OutputCompression
		}
		if opts.Out == "" {
			opts.Out = filepath.Join(*outDir, fmt.Sprintf("%03d-%s.%s", idx+1, slugify(opts.Prompt), normalizedOutputFormat(opts.OutputFormat)))
		}
		if err := generate(opts); err != nil {
			return fmt.Errorf("job %d failed: %w", idx+1, err)
		}
	}
	return nil
}

func generate(opts generateOptions) error {
	prompt, err := readPrompt(opts.Prompt, opts.PromptFile)
	if err != nil {
		return err
	}
	if err := validateGenerateOptions(opts); err != nil {
		return err
	}
	var apiKeys []apiKeyCandidate
	finalPrompt := prompt
	if len(opts.ImagePaths) > 0 {
		apiKeys, err = readAPIKeyCandidates()
		if err != nil {
			return err
		}
		description, err := describeImagesWithCandidates(apiKeys, opts.ImagePaths, opts.VisionModel)
		if err != nil {
			return err
		}
		finalPrompt = composeFinalPrompt(description, prompt)
	}
	outputFormat := normalizedOutputFormat(opts.OutputFormat)
	outputs := buildOutputPaths(opts.Out, opts.OutDir, outputFormat, opts.N, finalPrompt)
	payload := map[string]any{
		"model":         opts.Model,
		"prompt":        finalPrompt,
		"n":             opts.N,
		"size":          opts.Size,
		"quality":       opts.Quality,
		"output_format": outputFormat,
	}
	addNonEmpty(payload, "background", opts.Background)
	addNonEmpty(payload, "moderation", opts.Moderation)
	if opts.OutputCompression >= 0 {
		payload["output_compression"] = opts.OutputCompression
	}
	if opts.DryRun {
		return printDryRun(payload, outputs)
	}
	if len(apiKeys) == 0 {
		apiKeys, err = readAPIKeyCandidates()
		if err != nil {
			return err
		}
	}
	result, err := callImageGenerationAPIWithCandidates(apiKeys, payload)
	if err != nil {
		return err
	}
	if len(result.Data) == 0 {
		return errors.New("image API returned no images")
	}
	return writeImages(result.Data, outputs, opts.Force)
}

func validateGenerateOptions(opts generateOptions) error {
	if opts.N < 1 || opts.N > 10 {
		return errors.New("--n must be between 1 and 10")
	}
	switch normalizedOutputFormat(opts.OutputFormat) {
	case "png", "jpeg", "webp":
	default:
		return errors.New("--output-format must be png, jpeg, jpg, or webp")
	}
	switch opts.Quality {
	case "low", "medium", "high", "auto":
	default:
		return errors.New("--quality must be low, medium, high, or auto")
	}
	if opts.Model == defaultModel && opts.Background == "transparent" {
		return errors.New("gpt-image-2 does not support background=transparent; use chroma-key generation plus local background removal")
	}
	if opts.OutputCompression > 100 {
		return errors.New("--output-compression must be between 0 and 100")
	}
	return nil
}

func composeFinalPrompt(imageDescription string, userPrompt string) string {
	imageDescription = strings.TrimSpace(imageDescription)
	userPrompt = strings.TrimSpace(userPrompt)
	if imageDescription == "" {
		return userPrompt
	}
	return strings.TrimSpace("基于参考图片内容生成新图片。\n\n参考图片理解：\n" + imageDescription + "\n\n用户要求：\n" + userPrompt + "\n\n请综合参考图片的主体、场景、构图、风格、颜色、文字和用户要求生成最终图片；如用户要求修改或优化图片，请保留参考图片中未被要求改变的关键视觉元素。")
}

func readPrompt(prompt string, promptFile string) (string, error) {
	if strings.TrimSpace(prompt) != "" && strings.TrimSpace(promptFile) != "" {
		return "", errors.New("use --prompt or --prompt-file, not both")
	}
	if strings.TrimSpace(promptFile) != "" {
		data, err := os.ReadFile(promptFile)
		if err != nil {
			return "", err
		}
		prompt = string(data)
	}
	prompt = strings.TrimSpace(prompt)
	if prompt == "" {
		return "", errors.New("missing prompt")
	}
	return prompt, nil
}

func callImageGenerationAPIWithCandidates(candidates []apiKeyCandidate, payload map[string]any) (*imageResponse, error) {
	var unauthorizedSources []string
	var lastUnauthorized *apiError
	for _, candidate := range candidates {
		result, err := callImageGenerationAPI(candidate.Key, payload)
		if err == nil {
			return result, nil
		}
		var apiErr *apiError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusUnauthorized {
			unauthorizedSources = append(unauthorizedSources, candidate.Source)
			lastUnauthorized = apiErr
			continue
		}
		return nil, err
	}
	if lastUnauthorized != nil {
		return nil, fmt.Errorf(
			"image API rejected all credential sources (%s): HTTP %d: %s. Sign in to RuiZhi again or set RUIZHI_API_KEY",
			strings.Join(unauthorizedSources, ", "),
			lastUnauthorized.StatusCode,
			strings.TrimSpace(lastUnauthorized.Body),
		)
	}
	return nil, errors.New("missing image API credential: sign in to RuiZhi first or set RUIZHI_API_KEY")
}

func describeImagesWithCandidates(candidates []apiKeyCandidate, imagePaths []string, visionModel string) (string, error) {
	var unauthorizedSources []string
	var lastUnauthorized *apiError
	for _, candidate := range candidates {
		description, err := describeImages(candidate.Key, imagePaths, visionModel)
		if err == nil {
			return description, nil
		}
		var apiErr *apiError
		if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusUnauthorized {
			unauthorizedSources = append(unauthorizedSources, candidate.Source)
			lastUnauthorized = apiErr
			continue
		}
		return "", err
	}
	if lastUnauthorized != nil {
		return "", fmt.Errorf(
			"vision API rejected all credential sources (%s): HTTP %d: %s. Sign in to RuiZhi again or set RUIZHI_API_KEY",
			strings.Join(unauthorizedSources, ", "),
			lastUnauthorized.StatusCode,
			strings.TrimSpace(lastUnauthorized.Body),
		)
	}
	return "", errors.New("missing vision API credential: sign in to RuiZhi first or set RUIZHI_API_KEY")
}

func describeImages(apiKey string, imagePaths []string, visionModel string) (string, error) {
	content := []map[string]any{{
		"type": "input_text",
		"text": "请理解随后的参考图片，并只输出一段适合图像生成模型使用的中文视觉描述。必须覆盖主体、场景、构图、颜色、风格、可见文字、重要细节，以及哪些视觉元素应优先保留。不要询问用户，不要输出 Markdown。",
	}}
	for _, imagePath := range imagePaths {
		dataURL, err := imageDataURL(imagePath)
		if err != nil {
			return "", err
		}
		content = append(content, map[string]any{
			"type":      "input_image",
			"image_url": dataURL,
		})
	}
	payload := map[string]any{
		"model": valueOr(visionModel, defaultVisionModel),
		"input": []map[string]any{{
			"role":    "user",
			"content": content,
		}},
		"max_output_tokens": 600,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	endpoint, err := joinEndpoint(baseURL(), "/responses")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024*1024))
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		preview := string(data)
		if len(preview) > 4096 {
			preview = preview[:4096]
		}
		return "", &apiError{StatusCode: resp.StatusCode, Body: preview}
	}
	var result responsesAPIResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return "", err
	}
	description := strings.TrimSpace(extractResponsesText(result))
	if description == "" {
		return "", errors.New("vision API returned empty image description")
	}
	return description, nil
}

func extractResponsesText(result responsesAPIResponse) string {
	if strings.TrimSpace(result.OutputText) != "" {
		return strings.TrimSpace(result.OutputText)
	}
	var parts []string
	for _, output := range result.Output {
		if output.Type != "message" && output.Type != "" {
			continue
		}
		for _, content := range output.Content {
			if strings.TrimSpace(content.Text) != "" {
				parts = append(parts, strings.TrimSpace(content.Text))
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func callImageGenerationAPI(apiKey string, payload map[string]any) (*imageResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	endpoint, err := joinEndpoint(baseURL(), "/images/generations")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		preview := string(data)
		if len(preview) > 4096 {
			preview = preview[:4096]
		}
		return nil, &apiError{StatusCode: resp.StatusCode, Body: preview}
	}
	var result imageResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func writeImages(items []imageResponseItem, outputs []string, force bool) error {
	for i, item := range items {
		if i >= len(outputs) {
			break
		}
		raw, err := imageBytes(item)
		if err != nil {
			return err
		}
		out := outputs[i]
		if err := writeOutputFile(out, raw, force); err != nil {
			return err
		}
		abs, _ := filepath.Abs(out)
		fmt.Println("Wrote", abs)
		fmt.Println("Markdown", markdownImage(abs))
		fmt.Println(markdownImage(abs))
	}
	return nil
}

func markdownImage(path string) string {
	target := filepath.ToSlash(path)
	if strings.ContainsAny(target, " \t()<>") {
		target = "<" + strings.ReplaceAll(target, ">", "%3E") + ">"
	}
	return fmt.Sprintf("![generated image](%s)", target)
}

func imageBytes(item imageResponseItem) ([]byte, error) {
	if strings.TrimSpace(item.B64JSON) != "" {
		return base64.StdEncoding.DecodeString(item.B64JSON)
	}
	if strings.TrimSpace(item.URL) != "" {
		resp, err := http.Get(item.URL)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("image download failed: HTTP %d", resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 64*1024*1024))
	}
	return nil, errors.New("image item did not include b64_json or url")
}

func imageDataURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("empty --image path")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read reference image %s: %w", path, err)
	}
	mimeType, err := imageMIMEType(path, data)
	if err != nil {
		return "", err
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func imageMIMEType(path string, data []byte) (string, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png", nil
	case ".jpg", ".jpeg":
		return "image/jpeg", nil
	case ".webp":
		return "image/webp", nil
	}
	detected := http.DetectContentType(data)
	switch detected {
	case "image/png", "image/jpeg", "image/webp":
		return detected, nil
	default:
		return "", fmt.Errorf("unsupported reference image format for %s: %s", path, detected)
	}
}

func writeOutputFile(path string, data []byte, force bool) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("empty output path")
	}
	if _, err := os.Stat(path); err == nil && !force {
		return fmt.Errorf("output already exists: %s (use --force)", path)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func readAPIKeyCandidates() ([]apiKeyCandidate, error) {
	var candidates []apiKeyCandidate
	seen := map[string]bool{}
	add := func(source string, key string) {
		key = strings.TrimSpace(key)
		if key == "" || seen[key] {
			return
		}
		seen[key] = true
		candidates = append(candidates, apiKeyCandidate{Key: key, Source: source})
	}

	add("RUIZHI_API_KEY", os.Getenv("RUIZHI_API_KEY"))
	add("RUIJIE_UNIAPI_KEY", os.Getenv("RUIJIE_UNIAPI_KEY"))
	add("API_KEY", os.Getenv("API_KEY"))
	for _, path := range authJSONPaths() {
		key, err := readAPIKeyFromAuthJSON(path)
		if err == nil {
			add(fmt.Sprintf("auth.json at %s", path), key)
		}
	}
	add("OPENAI_API_KEY", os.Getenv("OPENAI_API_KEY"))

	if len(candidates) == 0 {
		return nil, errors.New("missing image API credential: sign in to RuiZhi first or set RUIZHI_API_KEY")
	}
	return candidates, nil
}

func readAPIKeyFromAuthJSON(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var auth struct {
		OpenAIAPIKey    string `json:"OPENAI_API_KEY"`
		RuiZhiAPIKey    string `json:"RUIZHI_API_KEY"`
		RuiJieUniAPIKey string `json:"RUIJIE_UNIAPI_KEY"`
		Tokens          struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(data, &auth); err != nil {
		return "", err
	}
	for _, value := range []string{auth.RuiZhiAPIKey, auth.RuiJieUniAPIKey, auth.Tokens.AccessToken, auth.OpenAIAPIKey} {
		if token := strings.TrimSpace(value); token != "" {
			return token, nil
		}
	}
	return "", errors.New("auth.json does not contain a usable image API credential")
}

func authJSONPaths() []string {
	var roots []string
	addRoot := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		for _, existing := range roots {
			if strings.EqualFold(existing, value) {
				return
			}
		}
		roots = append(roots, value)
	}
	addRoot(os.Getenv("RUIZHI_HOME"))
	addRoot(os.Getenv("CODEX_HOME"))
	if home, err := os.UserHomeDir(); err == nil {
		addRoot(filepath.Join(home, ".ruizhi"))
		addRoot(filepath.Join(home, ".codex"))
	}
	paths := make([]string, 0, len(roots))
	for _, root := range roots {
		paths = append(paths, filepath.Join(root, "auth.json"))
	}
	return paths
}

func baseURL() string {
	for _, name := range []string{"RUIZHI_OPENAI_BASE_URL", "BASE_URL", "OPENAI_BASE_URL"} {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return strings.TrimRight(value, "/")
		}
	}
	return defaultBaseURL
}

func joinEndpoint(base string, suffix string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(base, "/"))
	if err != nil {
		return "", err
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + suffix
	return parsed.String(), nil
}

func buildOutputPaths(out string, outDir string, outputFormat string, n int, prompt string) []string {
	if strings.TrimSpace(outDir) != "" && strings.TrimSpace(out) == defaultOutputPath {
		out = filepath.Join(outDir, slugify(prompt)+"."+outputFormat)
	}
	if n == 1 {
		return []string{out}
	}
	ext := filepath.Ext(out)
	base := strings.TrimSuffix(out, ext)
	if ext == "" {
		ext = "." + outputFormat
	}
	paths := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		paths = append(paths, base+"-"+strconv.Itoa(i)+ext)
	}
	return paths
}

func printDryRun(payload map[string]any, outputs []string) error {
	request := map[string]any{
		"endpoint": "/v1/images/generations",
		"base_url": baseURL(),
		"outputs":  outputs,
	}
	for key, value := range payload {
		request[key] = value
	}
	out, err := json.MarshalIndent(request, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(out))
	return nil
}

func readJobs(path string) ([]batchJob, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var jobs []batchJob
	for idx, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var job batchJob
		if strings.HasPrefix(line, "{") {
			if err := json.Unmarshal([]byte(line), &job); err != nil {
				return nil, fmt.Errorf("invalid JSON on line %d: %w", idx+1, err)
			}
		} else {
			job.Prompt = line
		}
		if strings.TrimSpace(job.Prompt) == "" {
			return nil, fmt.Errorf("missing prompt on line %d", idx+1)
		}
		jobs = append(jobs, job)
	}
	if len(jobs) == 0 {
		return nil, errors.New("jobs file is empty")
	}
	return jobs, nil
}

func addNonEmpty(payload map[string]any, key string, value string) {
	if strings.TrimSpace(value) != "" {
		payload[key] = value
	}
}

func valueOr(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func envOr(name string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func intOr(value int, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func normalizedOutputFormat(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "jpg" {
		return "jpeg"
	}
	if value == "" {
		return defaultOutputFormat
	}
	return value
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = slugPattern.ReplaceAllString(value, "-")
	value = strings.Trim(value, "-")
	if len(value) > 60 {
		value = value[:60]
		value = strings.Trim(value, "-")
	}
	if value == "" {
		return "image"
	}
	return value
}
