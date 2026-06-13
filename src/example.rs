use bevy::prelude::*;

/// 控制玩家的核心组件。
///
/// 包含移动速度以及玩家的当前生命值。
/// 在 `player_movement` 系统中会被读取和更新。
#[derive(Component)]
pub struct PlayerController {
    /// 玩家的移动速度
    pub speed: f32,
    /// 玩家的生命值
    pub health: u32,
}

/// 全局游戏配置资源。
///
/// 用于管理窗口标题、难度级别以及是否处于开发者调试模式下。
#[derive(Resource)]
pub struct GameConfig {
    pub title: String,
    pub difficulty: u8,
    pub is_debug: bool,
}

/// 实体之间发生物理碰撞的事件。
///
/// 当两个碰撞体相交时会被触发，发送相交的两个实体 ID 及其碰撞强度。
#[derive(Event)]
pub struct CollisionEvent {
    pub entity_a: Entity,
    pub entity_b: Entity,
    pub impulse: f32,
}

/// 用于在网络中同步的玩家加入游戏的消息。
///
/// 该消息会在玩家通过 TCP 成功握手后进行反序列化和分发。
#[derive(Message)]
pub struct PlayerJoinedMessage {
    pub player_id: u64,
    pub username: String,
}

/// 负责玩家逻辑生命周期和移动控制的 Bevy 插件。
///
/// 该插件会注册 `PlayerController` 组件、`CollisionEvent` 事件，
/// 并添加 `spawn_player` 和 `player_movement` 系统。
pub struct PlayerPlugin;

impl Plugin for PlayerPlugin {
    fn build(&self, app: &mut App) {
        app.add_event::<CollisionEvent>()
           .add_systems(Startup, spawn_player)
           .add_systems(Update, player_movement);
    }
}

/// 游戏启动时生成玩家实体的系统。
///
/// 该系统会被注册到 `Startup` 阶段，创建一个带有 `PlayerController` 和
/// 基础 `Transform` 的实体。
fn spawn_player(mut commands: Commands) {
    // 逻辑实现...
}

/// 每一帧根据用户输入来更新玩家移动的系统。
///
/// 该系统会查询所有带有 `PlayerController` 的实体，
/// 并读取键盘输入资源 `ButtonInput<KeyCode>` 来调整位置。
fn player_movement(
    time: Res<Time>,
    keyboard_input: Res<ButtonInput<KeyCode>>,
    mut query: Query<(&mut Transform, &PlayerController)>,
) {
    // 逻辑实现...
}
