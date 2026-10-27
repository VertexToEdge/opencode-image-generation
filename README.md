# OpenCode Image Generation

[![CI](https://github.com/VertexToEdge/opencode-image-generation/actions/workflows/ci.yml/badge.svg)](https://github.com/VertexToEdge/opencode-image-generation/actions/workflows/ci.yml)

Responses API와 `image_generation` 도구를 지원하는 OpenAI 호환 API에서 이미지를 생성·편집하고, 결과를 파일과 OpenCode 이미지 첨부로 반환하는 플러그인입니다.

- 기존 OpenCode provider의 API 주소와 인증 재사용
- 이미지 생성, 참조 이미지 편집, 마스크를 이용한 부분 편집
- 해상도·가로/세로·품질·투명 배경·출력 형식 지정
- 반환 이미지의 실제 해상도·파일 형식·투명 픽셀 검사
- AI용 전용 스킬과 모의 API 기반 테스트 포함

## 설치

Node.js 22 이상과 OpenCode가 필요합니다. OpenCode `1.19.4`에서 검증했습니다.

```bash
gh repo clone VertexToEdge/opencode-image-generation
cd opencode-image-generation
npm ci
npm run build
```

OpenCode 전역 `~/.config/opencode/opencode.json` 또는 프로젝트 `opencode.json`의 기존 설정에 `plugin` 항목을 추가합니다. 경로는 방금 복제한 저장소의 실제 절대 경로로 바꿉니다.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/opencode-image-generation/dist/index.js"]
}
```

전용 AI 스킬도 설치합니다.

```bash
mkdir -p ~/.config/opencode/skills
cp -R skills/gateway-image-generation ~/.config/opencode/skills/
```

`XDG_CONFIG_HOME`을 설정했다면 해당 디렉터리의 `opencode/skills/`에 복사합니다. OpenCode를 재시작하면 `codex_generate_image` 도구와 `gateway-image-generation` 스킬을 사용할 수 있습니다.

## API 연결과 인증

기존에 연결된 OpenCode provider를 사용합니다. 해당 provider의 `options.baseURL`에 OpenAI 호환 API 기본 주소가 설정되어 있어야 합니다.

```json
{
  "provider": {
    "compatible": {
      "npm": "@ai-sdk/openai",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    }
  }
}
```

위 예시는 기존 provider 설정에 합칠 항목입니다. API 주소와 provider ID를 자신의 환경에 맞게 바꾸고, 실제 채팅 모델 설정도 해당 서비스에 맞게 구성합니다. API 키는 `options.apiKey` 또는 OpenCode의 `auth.json`에서 읽습니다. 별도 키를 소스에 넣지 않습니다.

API 요청 주소는 선택된 provider의 `baseURL` 끝에 `/responses`를 붙여 결정합니다. 예를 들어 `https://api.example.com/v1`이면 `POST https://api.example.com/v1/responses`로 호출합니다. 연결할 서비스는 Responses API와 `image_generation` 도구를 지원해야 합니다.

Provider 우선순위는 이미지 전용 설정의 `provider`, 현재 대화의 provider, OpenCode 기본 모델의 provider 순서입니다. 이미지 모델은 도구 호출의 `model`, 이미지 전용 설정의 `model`, 현재 대화 모델, OpenCode 기본 모델 순으로 결정합니다.

## 사용

자연어로 요청하면 AI가 전용 스킬을 읽고 도구를 호출합니다.

```text
gpt-image-2.5-flare로 1024x1536 세로 포스터를 high 품질로 만들어서 프로젝트에 저장해줘.
```

```text
gpt-image-2.5-sunburst로 1536x864 배너를 만들어줘. 배경은 실제 투명 배경이고 PNG로 저장해줘.
```

```text
assets/product.png를 편집해서 제품은 유지하고 배경만 투명하게 바꿔줘. gpt-image-2.5-flare를 사용해줘.
```

```text
assets/base.png의 assets/mask.png에서 투명하게 표시한 부분만 수정해서 꽃을 추가해줘.
```

명시적인 이미지 생성·편집 요청에만 호출하며, 생성 시 provider의 이미지 할당량을 소비합니다.

## 도구 옵션

| 옵션 | 내용 |
| --- | --- |
| `prompt` | 필수. 주제, 구도, 스타일, 정확한 문구, 편집할 부분과 유지할 부분 |
| `model` | 요청할 API 모델. 예: `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` |
| `size` | `auto` 또는 `WIDTHxHEIGHT`. 예: `1024x1024`, `1536x1024`, `1024x1536`, `1536x864` |
| `width`, `height` | 픽셀 크기 두 값을 함께 지정. `size`와 동시에 지정하지 않음 |
| `quality` | `auto`, `low`, `medium`, `high`, `xhigh`, `max` |
| `background` | `auto`, `opaque`, `transparent` |
| `action` | `auto`, `generate`, `edit`. 마스크가 있고 생략하면 `edit` |
| `referencePaths` | 로컬 PNG/JPEG/WebP 파일 목록. 편집할 원본을 첫 번째에 배치 |
| `maskPath` | 선택적 PNG 마스크. 투명한 부분이 편집할 영역 |
| `outputFormat` | `png`, `jpeg`, `webp`. 기본 `png` |
| `outputCompression` | JPEG/WebP의 압축 설정 0–100. PNG에서는 생략 |
| `save` | `global`, `project`, `custom`, `none`. 기본 `global` |
| `saveDir` | `custom` 모드 저장 폴더. 상대 경로와 `~/` 지원 |

`quality`는 채팅 모델의 reasoning effort와 별개입니다. GPT Image 2.5 Flare/Sunburst는 `xhigh`·`max` 이미지 품질과 투명 배경을 지원합니다. 다른 모델이나 API 서비스의 동작은 다를 수 있습니다.

## 해상도와 방향

GPT Image 2/2.5의 사용자 지정 크기는 가로·세로가 16의 배수여야 합니다. 종횡비는 1:3부터 3:1까지이며, 가장 긴 변은 최대 3840, 총 픽셀 수는 최대 3840×2160입니다. 2560×1440보다 큰 크기는 실험적이고 모델에 따라 추가 제한이 있을 수 있습니다.

- 정사각형: `1024x1024`
- 가로: `1536x1024`
- 세로: `1024x1536`
- 가로 16:9: `1536x864`
- 세로 9:16: `864x1536`
- 사용자 지정 예: `width=2048`, `height=1152`

1920×1080처럼 한 변이 16의 배수가 아닌 정확한 최종 크기는 별도 리사이즈/크롭이 필요합니다. 플러그인은 반환 이미지를 자동으로 리사이즈하지 않습니다.

## 편집과 마스크

기존 파일을 수정하려면 `action="edit"`와 `referencePaths`를 사용합니다. 첫 번째 이미지를 원본으로, 나머지를 참조 이미지로 전달합니다. 이미지 바이트는 `input_image`로 업로드되고, OpenCode의 파일 읽기와 외부 디렉터리 권한을 따릅니다.

마스크는 첫 번째 이미지와 크기가 같은 PNG이며 알파 채널과 투명 픽셀이 있어야 합니다. 투명 영역이 편집 영역이고 불투명 영역은 유지하도록 요청합니다. 원본 파일은 덮어쓰지 않고 새 결과를 저장합니다.

참조 이미지는 최대 16개, 마스크를 포함한 입력 파일 합계는 최대 50 MiB입니다. 상대 경로는 작업 디렉터리를 기준으로 해석하며 `~/`도 지원합니다.

## 투명도와 실제 결과 확인

투명 배경은 `background="transparent"`와 PNG/WebP를 사용합니다. JPEG는 알파 채널이 없으므로 투명 배경과 함께 지정하면 생성 요청 전에 오류를 반환합니다.

플러그인은 반환 파일을 디코딩해 실제 크기·형식·알파 채널·투명 픽셀 유무를 확인합니다. 요청과 실제 해상도, 투명도, 형식이 다르면 `metadata.warnings`와 도구 출력에 표시합니다. 파일 확장자와 첨부 MIME은 실제 반환된 형식을 따르며, 경고가 생겼다고 이미지를 자동으로 재생성하지 않습니다.

## 저장과 기본값

- `global`: `~/.local/share/opencode/generated-images/<session-id>/` 또는 해당 XDG 데이터 폴더
- `project`: `<project>/.opencode/generated-images/<session-id>/`
- `custom`: `<saveDir>/<session-id>/`
- `none`: 저장 없이 이미지 첨부만 반환

전역 `~/.config/opencode/image-generation.json`이나 프로젝트 `.opencode/image-generation.json`으로 기본값을 지정할 수 있습니다. 프로젝트 설정이 우선합니다.

```json
{
  "provider": "compatible",
  "model": "gpt-image-2.5-flare",
  "save": "global"
}
```

`provider`를 생략하면 현재 대화의 provider를 따릅니다. `saveDir`도 지정할 수 있습니다. 환경 변수 `OPENCODE_IMAGE_SAVE_MODE`, `OPENCODE_IMAGE_SAVE_DIR`로 저장 기본값을 덮어쓸 수 있으며, 호출 시 지정한 `save`·`saveDir`이 최우선입니다. 예제 설정은 [`examples/`](examples/)에 있습니다.

## 개발과 검증

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

테스트는 실제 생성 API 대신 모의 Responses API 스트림과 로컬 이미지 파일을 사용합니다. 생성·편집 요청 형식, 마스크, 권한, 투명도·형식 확인, 스트림 종료, 취소, 재시도를 검증합니다. 테스트 과정에서 이미지 생성 API를 호출하지 않습니다. 각 서비스의 옵션 처리는 실제 생성 결과와 경고를 통해 확인할 수 있습니다.

- `src/`: TypeScript 플러그인과 이미지 처리 코드
- `skills/gateway-image-generation/`: AI 전용 지침
- `tests/`: 모의 API를 사용하는 테스트
- `.github/workflows/ci.yml`: Node.js 22·24 검사, 테스트, 패키지 구성 확인

API 요청 제한 시간은 전체 5분입니다. 취소와 일시적인 HTTP 오류 재시도를 지원하며 이미지가 도착하면 남은 스트림 종료를 기다리지 않습니다.

## 라이선스

[Apache-2.0](LICENSE). 저작권·출처 고지는 [NOTICE](NOTICE)를 참고하세요.
