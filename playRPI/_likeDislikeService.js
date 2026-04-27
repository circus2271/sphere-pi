class LikeDislikeService {
    scheduled = false
    newStatus = null

    scheduleLikeDislike({ newStatus }) {
        // make sure first letter is capitalized
        const firstLetter = newStatus[0].toUpperCase()
        const normalizedStatus = firstLetter + newStatus.toLowerCase().slice(1)

        this.scheduled = true
        this.newStatus = normalizedStatus
    }

    resetLikeDislikeScheduledValues = () => {
        // clean up
        this.scheduled = false
        this.newStatus = null
    }
}

module.exports = new LikeDislikeService()
