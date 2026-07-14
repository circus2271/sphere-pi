class LikeDislikeService {
    scheduled = false
    newStatus = null
    
    constructor() {
      console.log('init')
    }

    scheduleLikeDislike({ newStatus }) {
        // make sure first letter is capitalized
        const firstLetter = newStatus[0].toUpperCase()
        const normalizedStatus = firstLetter + newStatus.toLowerCase().slice(1)
        console.log('111')
        this.scheduled = true
        this.newStatus = normalizedStatus
        console.log(`${this.newStatus} scheduled`)
    }

    resetLikeDislikeScheduledValues = () => {
        // clean up
        this.scheduled = false
        this.newStatus = null
    }
}

module.exports = new LikeDislikeService()
