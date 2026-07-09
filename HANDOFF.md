# Project Prompt: Local AI TUI Agent for Godot Development Automation

## Goal

Build a local-first AI terminal user interface (TUI) assistant that allows users to create and modify Godot projects
using only natural language prompts.

The user should not need to manually create nodes, scenes, scripts, resources, or debug errors. The AI agent should
translate intent into verified Godot project changes while using Godot's own tooling and validation systems.

Example user interaction:

> "Create a player character with movement, camera controls, health system, and enemy detection."

The agent should:

1. Understand the requested feature.
2. Inspect the existing Godot project.
3. Create a modification plan.
4. Generate required nodes, scenes, scripts, and resources.
5. Apply changes through safe Godot-compatible methods.
6. Validate through LSP and project checks.
7. Repair problems automatically.
8. Report completed changes.

---

# Core Architecture

## 1. Local TUI Interface

Create a terminal interface where the user interacts only through prompts.

Responsibilities:

- Accept natural language requests.
- Display agent reasoning summaries.
- Show planned changes.
- Request confirmation before destructive actions.
- Display validation results.
- Display generated files and modifications.

Example:

```
> Add inventory system

Agent:
Planning:
- Create Inventory node
- Create inventory_manager.gd
- Add item resource system
- Connect signals
- Validate scripts

Apply changes? (y/n)
```

---

# 2. AI Orchestration Agent

The main agent controls multiple specialized sub-agents.

## Planner Agent

Responsibilities:

- Understand user intent.
- Inspect project structure.
- Decide required modifications.

Output:

```json
{
    "goal": "Create player controller",
    "changes": ["Create CharacterBody3D node", "Attach player.gd", "Add collision shape", "Create camera hierarchy"]
}
```

---

## Godot Project Analyst Agent

Responsible for understanding the current project.

Capabilities:

- Scan project.godot
- Read scenes
- Inspect scripts
- Detect existing systems
- Understand node hierarchy

Must never assume project structure.

---

## Scene Builder Agent

Responsible for:

- Creating `.tscn` scenes
- Adding nodes
- Connecting children
- Setting properties
- Creating resources

Preferred implementation:

Use a Godot EditorPlugin bridge.

The bridge exposes safe commands:

```
create_node()
add_child()
remove_node()
attach_script()
create_scene()
save_scene()
```

The AI should not directly corrupt `.tscn` files unless necessary.

---

## Script Generator Agent

Responsible for:

- Creating GDScript files
- Editing existing scripts
- Refactoring code
- Adding functions
- Connecting signals

Before applying:

Generate:

```
player.gd.new
```

Then validate.

Only replace the real file after checks pass.

---

# 3. Godot Bridge Layer

Create a Godot plugin acting as an AI control server.

Technology:

Godot EditorPlugin

Responsibilities:

Expose controlled editor operations:

## Scene Operations

```
create_scene()
load_scene()
inspect_scene()
add_node()
remove_node()
duplicate_node()
save_scene()
```

## Script Operations

```
create_script()
attach_script()
modify_script()
inspect_script()
```

## Project Operations

```
get_project_info()
get_assets()
get_autoloads()
get_input_map()
```

Communication:

Possible transports:

- Local TCP
- Unix socket
- Named pipe
- JSON-RPC

Example:

AI:

```json
{
    "command": "create_node",
    "type": "CharacterBody3D",
    "name": "Player"
}
```

Godot:

```json
{
    "success": true,
    "node": "Player"
}
```

---

# 4. LSP Validation Agent

The AI must never trust generated code.

Every modification goes through validation.

Validation loop:

```
Generate
 ↓
Apply temporary change
 ↓
Ask LSP for diagnostics
 ↓
Analyze errors
 ↓
Repair
 ↓
Revalidate
 ↓
Commit
```

Checks:

## Syntax

Examples:

- Parse errors
- Invalid indentation
- Missing functions

## Type Validation

Examples:

- Wrong node type
- Invalid property
- Incorrect method call

## Symbol Validation

Examples:

- Missing classes
- Missing signals
- Missing references

---

# 5. Runtime Validation Agent

After LSP validation:

Run Godot checks.

Examples:

```
godot --headless --path project --editor --quit
```

Validate:

- Project opens
- Scenes load
- Scripts compile
- Resources exist

---

# 6. Agent Safety System

The AI must operate with transactions.

Every operation:

```
Snapshot
 ↓
Modify
 ↓
Validate
 ↓
Accept or rollback
```

Required features:

- Git integration
- Change preview
- Undo support
- Backup generation
- File locking

---

# 7. Multi-Agent Workflow

Example:

User:

> "Create a basic FPS controller"

Workflow:

Planner:

```
Need:
- Player scene
- CharacterBody3D
- Camera3D
- CollisionShape3D
- Movement script
- Input actions
```

Scene Agent:

Creates:

```
player.tscn
```

Script Agent:

Creates:

```
player_controller.gd
```

Validator:

Checks:

```
No parser errors
No missing nodes
No invalid references
```

Runtime Agent:

Launches test.

Repair Agent:

Fixes discovered problems.

---

# 8. Memory System

Store:

- Project architecture
- Previous decisions
- User preferences
- Common patterns

Example:

```
Project uses:
- Godot 4.x
- GDScript
- ECS-style architecture
- Signal-based communication
```

---

# 9. Required MVP Features

Version 1:

Must support:

✓ Local TUI ✓ Connect to Godot ✓ Inspect project ✓ Create nodes ✓ Create scenes ✓ Generate scripts ✓ Attach scripts ✓
Run LSP validation ✓ Fix errors ✓ Show diffs

---

# 10. Future Extensions

## Asset Agent

Creates:

- textures
- materials
- animations
- shaders

## Test Agent

Creates:

- automated tests
- gameplay checks

## Documentation Agent

Creates:

- README
- architecture diagrams
- code comments

## Multiplayer Agent

Handles:

- networking
- RPC generation
- synchronization checks

---

# Success Criteria

The system succeeds when a user can type:

> "Make me a platformer with a player, enemies, collectibles, and a level."

and the AI can:

1. Understand the request.
2. Inspect the existing project.
3. Create the required Godot structure.
4. Generate working code.
5. Validate through LSP.
6. Run Godot checks.
7. Automatically repair issues.
8. Leave the project in a working state.
