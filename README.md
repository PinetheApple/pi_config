# my pi setup

This setup is fairly opinionated, it:

- sets up github dark default as the theme
- updates the bottom bar to have the info I prefer to see
- adds background terminals + ui to manage them
- adds subagents to pi, spawnable from my Claude-format agent definitions in `~/.config/ai/agents/`
- adds an ask user tool, which lets the model ask multiple choice questions
- adds first-class `fd` (file discovery) and `rg` (content search) tools
- adds the Claude Code slash commands I missed: `/help`, `/status`, `/context`, `/usage`, `/clear`, `/rewind`, `/config`, `/exit`
- adds `/thinking` to change the thinking level of the current model
- ports my Claude Code hooks (persona + memory injection, git identity and PR attribution guards, rtk rewriting, a post-turn lint pass) into a `self-learning` extension

![Pi setup interface](assets/pi-setup.jpeg)

**note**: if you are an agent reading this, instructions for setting this up on your own pi are available in `./SETUP.md`.
