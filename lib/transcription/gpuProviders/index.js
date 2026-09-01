// The interface every GPU rental provider module implements:
//   startInstance()               -> Promise<{ instanceId }>
//   getInstanceStatus(instanceId) -> Promise<{ ready, status, ports }>
//   stopInstance(instanceId)      -> Promise<void>
//
// RunPod is the only provider wired up for v1 (see README for why).
// Swapping to a different one later means writing a new module against
// this same interface and changing the require below — selfhosted.js never
// touches a provider module directly.
module.exports = require('./runpod');
