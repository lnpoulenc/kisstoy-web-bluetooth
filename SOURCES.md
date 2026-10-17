# 来源、协议参考与授权边界

本项目是独立的浏览器本地蓝牙控制界面，与设备厂商及下列参考项目没有隶属或背书关系。这里分别列出代码改编、协议资料参考和使用背景；它们不具有相同的授权范围。

## 1. Buttplug：实际代码改编，BSD-3-Clause

`protocol.mjs` 的 Galaku 密钥表、逐字节帧加密逻辑及 QCSW 双通道帧布局，改编自 Buttplug 的公开实现。设备服务与特征 UUID 也参考其配置。

为便于复核，来源固定到提交 `179b0d9306f519912c10bdddd111686622b7f63a`：

- [Galaku 协议实现 galaku.rs](https://github.com/buttplugio/buttplug/blob/179b0d9306f519912c10bdddd111686622b7f63a/crates/buttplug_server/src/device/protocol_impl/galaku.rs)
- [Galaku 设备配置 galaku.yml](https://github.com/buttplugio/buttplug/blob/179b0d9306f519912c10bdddd111686622b7f63a/crates/buttplug_server_device_config/device-config/protocols/galaku.yml)
- [上游 LICENSE](https://github.com/buttplugio/buttplug/blob/179b0d9306f519912c10bdddd111686622b7f63a/LICENSE)

上游协议文件标注 `Copyright (c) 2016-2026 Nonpolynomial Labs LLC`；根许可证保留 `Copyright (c) 2016-2023, Nonpolynomial Labs, LLC`。本仓库在 [THIRD-PARTY-LICENSE.txt](THIRD-PARTY-LICENSE.txt) 中保留 BSD 三条条件、版权与免责声明。本项目未使用上游 Joycon、hid-async 等其他组件。

## 2. aitoy_client：PLMX 协议资料参考

Polly Max（蓝牙名称 `PLMX`）的历史服务匹配、命令字、强度字段位置及发送顺序，参考 `FunnySaltyFish/aitoy_client` 的公开历史实现。帧加密仍使用上一节的 BSD 编码器。

参考固定到提交 `3cf99229e2ce731d10956add214bd3458a40e21b`：

- [KissToyProtocols.kt：设备匹配及历史命令](https://github.com/FunnySaltyFish/aitoy_client/blob/3cf99229e2ce731d10956add214bd3458a40e21b/composeApp/src/commonMain/kotlin/com/funny/aitoy/ble/protocols/KissToyProtocols.kt)
- [LoyoFrameCodec.kt：帧结构参考](https://github.com/FunnySaltyFish/aitoy_client/blob/3cf99229e2ce731d10956add214bd3458a40e21b/composeApp/src/commonMain/kotlin/com/funny/aitoy/ble/protocols/LoyoFrameCodec.kt)
- [该仓库第三方来源声明](https://github.com/FunnySaltyFish/aitoy_client/blob/3cf99229e2ce731d10956add214bd3458a40e21b/THIRD_PARTY_NOTICES.md)

截至 2026-10-17，在这一提交中未发现项目自身的开源许可证；第三方声明不等于对该项目源码的许可。本仓库不打包或分发其 Kotlin 源码，也不将其列为 BSD 授权依赖。此处引用的是设备协议资料，用于在既有编码器上实现 JavaScript 控制帧。

当前 PLMX 实现使用服务 `1000`、写入特征 `1001`，双路更新顺序为 `0x71/0 → 0x32/通道2 → 0x31/通道1`；停止发送组合零强度及各单通道零强度。未移植该参考项目 V2 协议的启动强度下限、握手或状态类。蓝牙写入成功不等于设备已经执行。

## 3. KissToy 远程控制教程：项目背景

最初的需求来自 [sue1231513/KissToy 的远程控制教程](https://github.com/sue1231513/KissToy/blob/main/kisstoy远程控制教程.md)。它帮助确定了设备场景和官方远程控制背景。

本项目实现的是手机浏览器直连 BLE，不调用教程中的官方远程 API，不复制其中教程文本或 Python 示例。截至 2026-10-17，该仓库未标注开源许可证；引用它不表示本仓库有权再许可其内容。

## 4. 浏览器行为与平台文档

- [Bluefy 官方 App Store 页面及版本记录](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)：iPhone Web Bluetooth、后台蓝牙设置及 `getDevices()` 支持参考。
- [Web Bluetooth：getDevices()](https://bluetooth.spec.whatwg.org/#dom-bluetooth-getdevices)：返回已授权设备，不等于在线扫描。
- [Web Bluetooth：GATT Server](https://bluetooth.spec.whatwg.org/#gatt-server)：连接状态与对象定义。
- [Chrome Web Bluetooth 文档](https://developer.chrome.com/docs/capabilities/bluetooth)：安全上下文、用户选择及断开后重新获取服务/特征。
- [Chrome 自动重连示例](https://googlechrome.github.io/samples/web-bluetooth/automatic-reconnect-async-await.html)：重连流程参考。本项目实现了有限重试、停止优先与恢复强度开关。
- [GitHub Pages 发布源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)：静态网页部署参考。

## 5. 本项目原创部分与实机反馈

中文页面、响应式样式、快捷强度按钮、设备列表/切换、停止优先队列、重连与页面生命周期协调、诊断界面及测试由本项目实现，按 [BSD-3-Clause](LICENSE) 发布。第三方改编部分仍保留其原版权声明。

PLMX 的“通道 1 旋转、通道 2 吮吸”来自项目使用者的设备实测反馈；名称 `PLMX` 本身不能确认具体代数。测试中的模拟蓝牙验证了帧格式和控制流程，不代表覆盖所有固件、批次或 iOS/Bluefy 版本。
