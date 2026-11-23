<div align="center">

# TAi

**一门研究生分布式系统课的 AI 助教（AI agent）**

[English](README.md) · [演示视频](https://www.youtube.com/watch?v=XpgPXcv_oyQ) · [文档索引](docs/README.md) · [论文对应版本 `thesis-2026-12`](https://github.com/YuzhengShi/tai-deploy/releases/tag/thesis-2026-12)

</div>

TAi 是东北大学温哥华校区 CS6650《Building Scalable Distributed Systems》课程的 AI 助教。它是一个围绕大语言模型、会调用工具的 AI agent。硕士论文《TAi: An Agentic Teaching Assistant for a Graduate Distributed Systems Course》（Yuzheng Shi，东北大学，2026 年 12 月）描述的就是这个系统。

## 它做什么

这门课 80% 的成绩在口头面试里评：

- **模拟面试，每周一次**：三名学生一组，助教负责组织和评分。学生当场讲清楚、跑起来自己这一周写的代码，再回答概念题。
- **两次 Mastery 面试**：期中一次，期末一次。

TAi 的主要工作是让学生先把这些话说出口。学生在网页上发起语音通话，就能和 TAi 一对一地做**练习面试**，内容是自己的代码和本周的作业。

- **通话中**：TAi 悄悄给每个回答打分，用来决定追问的方向。
- **结束时**：TAi 在聊天里留下一张复盘卡片。
- **不计成绩**：练习只给反馈，打分仍由助教负责。

论文从课程的教学和考核方式推出了 AI 助教要做的七件事（论文表 3.1），TAi 每件事都有一个对应的部分：

| # | 课程的需要 | 对应的部分 | 文档 |
|:-:|---|---|---|
| 1 | 让学生在模拟面试前练习讲解代码和概念 | 语音练习面试，每个回答按 4 个维度打 1–5 分 | [VOICE](docs/VOICE.md) |
| 2 | 了解学生这一周写的代码、交的作业和发的帖子，并能运行这些代码 | 每周简报和 Go 沙箱：一次性容器，运行时没有密钥、不联网 | [WEEKLY_BRIEF](docs/WEEKLY_BRIEF.md)、[GO_SANDBOX](docs/GO_SANDBOX.md) |
| 3 | 跟踪每个学生的学习进度 | 学生档案（由主机代码写入）和学生状态 | [STUDENT_MODEL](docs/STUDENT_MODEL.md)、[STUDENT_STATE](docs/STUDENT_STATE.md) |
| 4 | 在截止和面试前提醒学生 | 工作日巡查，先由主机代码的闸门决定要不要调用模型 | [PATROL](docs/PATROL.md) |
| 5 | 查学生自己的信息，看不到别人的 | 绑定到学生的 Canvas、GitHub、Piazza 工具 | [PORTAL](docs/PORTAL.md)、[SECURITY](docs/SECURITY.md) |
| 6 | 引导而不代做 | 人设里的规则：苏格拉底式提问，每次只问一个问题，不给作业答案 | [人设](groups/global/CLAUDE.md) |
| 7 | 让教学团队看到全班的情况，但看不到学生练习时的原话 | 教学团队页面（只读，掌握程度热图） | [TEAM_VIEW](docs/TEAM_VIEW.md) |

## 两个学期

| | 2026 春季 | 2026 秋季 |
|---|---|---|
| 运行在哪里 | AWS | 课程自己的服务器 |
| 入口 | WhatsApp | 需要 Google 登录的网页，通话在页面里 |
| 模型 | AWS Bedrock 上的 Claude | 经过网关（LiteLLM）：先是 Cerebras，然后 DeepSeek，2026-11-23（UTC）起是 z.ai 的 GLM（glm-5.3-flash） |
| 语音 | Amazon Nova 2 Sonic | Deepgram 语音代理加 TAi 的中继 |

架构图、运行方式、仓库结构和评测见[英文 README](README.md)。

## 评测

- **秋季评测和换用 pi 的检查**：[eval/RESULTS.md](eval/RESULTS.md)。
- **课程材料检索**：重建的 LeanRAG 图谱对 BM25，两组各 20 个问题都没有赢，见 [docs/LEANRAG.md](docs/LEANRAG.md)。
- **弱模型实验**：所有模型调用换成弱得多的模型，判据在计数运行前冻结，两轮按判据都是"不确定"，见 [eval/weak-model/](eval/weak-model/)（原始记录是中文）。
- **本地语音**：[docs/LOCAL_VOICE.md](docs/LOCAL_VOICE.md)。

所有检查都只用了作者自己的通话和账号，或合成学生，没有用学生数据。

## 引用

请引用论文。GitHub 的 "Cite this repository" 按钮读取 [`CITATION.cff`](CITATION.cff)；BibTeX 见[英文 README](README.md#citation)。

## 致谢与许可

- TAi 是 [NanoClaw](https://github.com/gavrielc/nanoclaw) 的分支，沿用它的 MIT 许可（[LICENSE](LICENSE) 保留了 NanoClaw 的版权声明）。
- 导师是课程的授课教师 Yvonne Coady 博士。
- 开发过程中使用了 AI 编程助手。
