import type { CpuDifficulty, GameMode, StagePreset } from '../game/types';
import { updateSettings, useGame } from '../runtime/store';
import { Segmented } from './controls';

const MODES: { value: GameMode; label: string }[] = [
  { value: 'pvp', label: '1P vs 2P' },
  { value: 'cpu', label: '1P vs CPU' },
];
const DIFFICULTIES: { value: CpuDifficulty; label: string }[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
const STAGES: { value: StagePreset; label: string }[] = [
  { value: 'standard', label: 'スタンダード机' },
  { value: 'ramps', label: 'ジャンプリング' },
  { value: 'sumo', label: 'シンプル土俵' },
];
const TARGETS = [
  { value: 3, label: '3点先取' },
  { value: 5, label: '5点先取' },
  { value: 0, label: 'フリー練習' },
];

export function RuleFields() {
  const mode = useGame((s) => s.mode);
  const cpuDifficulty = useGame((s) => s.cpuDifficulty);
  const stagePreset = useGame((s) => s.stagePreset);
  const targetScore = useGame((s) => s.targetScore);
  const online = useGame((s) => s.online.status === 'on');
  return (
    <>
      {!online && <Segmented label="モード" value={mode} options={MODES} onChange={(v) => updateSettings({ mode: v })} />}
      {(mode === 'cpu' || online) && (
        <Segmented
          label="CPU"
          value={cpuDifficulty}
          options={DIFFICULTIES}
          onChange={(v) => updateSettings({ cpuDifficulty: v })}
        />
      )}
      <Segmented label="ステージ" value={stagePreset} options={STAGES} onChange={(v) => updateSettings({ stagePreset: v })} />
      <Segmented label="ルール" value={targetScore} options={TARGETS} onChange={(v) => updateSettings({ targetScore: v })} />
    </>
  );
}
