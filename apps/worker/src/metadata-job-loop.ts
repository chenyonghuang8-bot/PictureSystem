import { SerialJobLoop } from "./serial-job-loop.js";
import type { MetadataJobDriver } from "./metadata-driver.js";
import { ControlAdmissionError } from "@family-album/storage";

/** Stop selection while draining the current recovery transaction or probe. */
export class MetadataJobLoop extends SerialJobLoop {
  constructor(
    private readonly driver: Pick<
      MetadataJobDriver,
      "recoverExpired" | "runNext" | "requestStop"
    >,
  ) {
    super(async () => {
      try {
        await driver.recoverExpired();
        if (!this.stopped && !(await driver.runNext())) await this.wait(1000);
      } catch (error) {
        if (!(error instanceof ControlAdmissionError)) throw error;
        await this.wait(1000);
      }
    });
  }
  override requestStop() {
    this.driver.requestStop();
    super.requestStop();
  }
}
