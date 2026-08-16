type StructuralObservation =
  | { readonly kind: "PRIMITIVE"; readonly value: unknown }
  | {
      readonly kind: "OBJECT" | "ARRAY";
      readonly prototype: "OBJECT" | "NULL" | "ARRAY";
      readonly keys: readonly string[];
      readonly descriptors: readonly {
        readonly key: string;
        readonly enumerable: boolean;
        readonly configurable: boolean;
        readonly writable: boolean;
        readonly value: StructuralObservation;
      }[];
    };

interface StructuralCapture {
  readonly data: unknown;
  readonly observation: StructuralObservation;
}

export interface JointStructuralCaptureResult {
  readonly stable: readonly boolean[];
  readonly jointlyConsistent: boolean;
  readonly data: readonly unknown[];
}

const JOINT_CAPTURE_DIRECTIONS = Object.freeze([
  "FORWARD",
  "REVERSE",
  "FORWARD",
  "REVERSE",
  "FORWARD",
  "REVERSE",
] as const);

const structuralObservationsEqual = (
  left: StructuralObservation,
  right: StructuralObservation,
): boolean => {
  if (left.kind === "PRIMITIVE" || right.kind === "PRIMITIVE") {
    return (
      left.kind === "PRIMITIVE" &&
      right.kind === "PRIMITIVE" &&
      Object.is(left.value, right.value)
    );
  }
  if (
    left.kind !== right.kind ||
    left.prototype !== right.prototype ||
    left.keys.length !== right.keys.length ||
    left.keys.some((key, index) => key !== right.keys[index]) ||
    left.descriptors.length !== right.descriptors.length
  ) {
    return false;
  }
  return left.descriptors.every((descriptor, index) => {
    const other = right.descriptors[index];
    return (
      other !== undefined &&
      descriptor.key === other.key &&
      descriptor.enumerable === other.enumerable &&
      descriptor.configurable === other.configurable &&
      descriptor.writable === other.writable &&
      structuralObservationsEqual(descriptor.value, other.value)
    );
  });
};

const jointObservationsEqual = (
  left: readonly (StructuralCapture | null)[],
  right: readonly (StructuralCapture | null)[],
): boolean =>
  left.length === right.length &&
  left.every((capture, index) => {
    const other = right[index];
    return (
      capture !== null &&
      other !== undefined &&
      other !== null &&
      structuralObservationsEqual(capture.observation, other.observation)
    );
  });

const captureStructuralDataOnce = (
  input: unknown,
  ancestors: Set<object>,
): StructuralCapture | null => {
  try {
    if ((typeof input !== "object" && typeof input !== "function") || input === null) {
      return {
        data: input,
        observation: { kind: "PRIMITIVE", value: input },
      };
    }
    if (typeof input === "function" || ancestors.has(input)) {
      return null;
    }

    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input) as unknown;
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(input);
    // Strict schema parsers may intentionally ignore this prototype-pollution
    // key, so reject it before parsing can erase an exact-shape violation.
    if (
      ownKeys.some(
        (key) => typeof key !== "string" || key === "__proto__",
      )
    ) {
      return null;
    }
    const keys = ownKeys as string[];
    const descriptors = keys.map((key) => ({
      key,
      descriptor: Object.getOwnPropertyDescriptor(input, key),
    }));
    if (
      descriptors.some(
        ({ descriptor }) => descriptor === undefined || !("value" in descriptor),
      )
    ) {
      return null;
    }

    if (isArray) {
      const lengthDescriptor = descriptors.find(({ key }) => key === "length")?.descriptor;
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        return null;
      }
      const length = lengthDescriptor.value as number;
      const expectedKeys = [
        ...Array.from({ length }, (_, index) => String(index)),
        "length",
      ];
      if (
        keys.length !== expectedKeys.length ||
        keys.some((key, index) => key !== expectedKeys[index]) ||
        descriptors.some(
          ({ key, descriptor }) =>
            key !== "length" && descriptor !== undefined && !descriptor.enumerable,
        )
      ) {
        return null;
      }
    } else if (descriptors.some(({ descriptor }) => !descriptor?.enumerable)) {
      return null;
    }

    ancestors.add(input);
    try {
      const capturedDescriptors: Array<{
        readonly key: string;
        readonly descriptor: PropertyDescriptor & { readonly value: unknown };
        readonly capture: StructuralCapture;
      }> = [];
      for (const { key, descriptor } of descriptors) {
        if (descriptor === undefined || !("value" in descriptor)) {
          return null;
        }
        const capture = captureStructuralDataOnce(descriptor.value, ancestors);
        if (capture === null) {
          return null;
        }
        capturedDescriptors.push({
          key,
          descriptor: descriptor as PropertyDescriptor & { readonly value: unknown },
          capture,
        });
      }

      let data: unknown;
      if (isArray) {
        const lengthDescriptor = descriptors.find(({ key }) => key === "length")!.descriptor!;
        const length = (lengthDescriptor as PropertyDescriptor & { value: number }).value;
        data = Array.from({ length }, (_, index) =>
          capturedDescriptors.find(({ key }) => key === String(index))!.capture.data,
        );
      } else {
        const capturedRecord = Object.create(
          prototype === null ? null : Object.prototype,
        ) as Record<string, unknown>;
        for (const { key, capture } of capturedDescriptors) {
          Object.defineProperty(capturedRecord, key, {
            value: capture.data,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        }
        data = capturedRecord;
      }

      return {
        data,
        observation: {
          kind: isArray ? "ARRAY" : "OBJECT",
          prototype: isArray ? "ARRAY" : prototype === null ? "NULL" : "OBJECT",
          keys,
          descriptors: capturedDescriptors.map(({ key, descriptor, capture }) => ({
            key,
            enumerable: descriptor.enumerable ?? false,
            configurable: descriptor.configurable ?? false,
            writable: descriptor.writable ?? false,
            value: capture.observation,
          })),
        },
      };
    } finally {
      ancestors.delete(input);
    }
  } catch {
    return null;
  }
};

/**
 * Captures caller-controlled inputs as alternating forward/reverse joint sweeps.
 * Every policy consumer receives only detached data from the first sweep, and
 * only when all complete joint observations agree across both input orders.
 */
export const captureJointlyStableStructuralDataList = (
  inputs: readonly unknown[],
): JointStructuralCaptureResult => {
  const forwardOrder = inputs.map((_input, index) => index);
  const reverseOrder = [...forwardOrder].reverse();
  const sweeps = JOINT_CAPTURE_DIRECTIONS.map((direction) => {
    const captures: Array<StructuralCapture | null> = Array.from(
      { length: inputs.length },
      () => null,
    );
    const order = direction === "FORWARD" ? forwardOrder : reverseOrder;
    for (const inputIndex of order) {
      captures[inputIndex] = captureStructuralDataOnce(
        inputs[inputIndex],
        new Set<object>(),
      );
    }
    return captures;
  });

  const firstSweep = sweeps[0]!;
  const stable = inputs.map((_input, inputIndex) => {
    const first = firstSweep[inputIndex];
    return (
      first !== undefined &&
      first !== null &&
      sweeps.slice(1).every((sweep) => {
        const capture = sweep[inputIndex];
        return (
          capture !== undefined &&
          capture !== null &&
          structuralObservationsEqual(first.observation, capture.observation)
        );
      })
    );
  });
  const jointlyConsistent = sweeps
    .slice(1)
    .every((sweep) => jointObservationsEqual(firstSweep, sweep));

  return {
    stable,
    jointlyConsistent,
    data: inputs.map((_input, inputIndex) =>
      stable[inputIndex] ? firstSweep[inputIndex]!.data : undefined,
    ),
  };
};
