import type { ControlAdmission } from "@family-album/storage";

/** Explicit HTTP unit fixture. Native/SQL integration uses a real deployment
 * gate and current control row, never this transport-test dependency. */
export const unitAdmissionFixture: ControlAdmission = Object.freeze({
  async run<T>(
    _action: Parameters<ControlAdmission["run"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> {
    void _action;
    return operation();
  },
});
